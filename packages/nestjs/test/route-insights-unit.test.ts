// P9-02: route histogram, window comparison, release comparison and the `maxDurationMs` trace
// filter, through the embedded handlers. No OpenTelemetry globals are touched.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ApiSources,
  routeCompareHandler,
  routeHistogramHandler,
  tracesHandler,
} from "../src/dashboard/api.js";
import { ClassStatistics } from "../src/stats/class-stats.js";
import { deltaOf } from "../src/stats/route-insights.js";
import {
  HISTOGRAM_BUCKETS,
  RouteStatistics,
} from "../src/stats/route-stats.js";
import { createStoreProcessor } from "../src/store/processor.js";
import { getOrCreateStore, resetStoreForTests } from "../src/store/store.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import { serverRoot } from "./store-helpers.js";

beforeEach(() => resetStoreForTests());
afterEach(() => resetStoreForTests());

const MINUTE = 60_000;
// A fixed instant in the middle of a minute.
const NOW = Math.floor(1_800_000_000_000 / MINUTE) * MINUTE + 30_000;

function sources(stats: RouteStatistics, withStore = false): ApiSources {
  const store = withStore
    ? getOrCreateStore({}, recordingDiagnostics())
    : undefined;
  store?.attach({});
  return {
    store,
    stats,
    classes: new ClassStatistics(NOW - 3 * 60 * MINUTE),
    service: { name: "shop" },
    sampling: { owner: "nestrix", rate: 1 },
    hostOwnsProvider: false,
    ignoresRoutes: false,
    fallbackProcessId: "x",
  };
}

const json = (r: { body?: unknown }) => JSON.parse(r.body as string);
const hist = (q: string) =>
  json(routeHistogramHandler(`/x?${q}`, currentSources, NOW));
const compare = (q: string) =>
  json(routeCompareHandler(`/x?${q}`, currentSources, NOW));
let currentSources: ApiSources;

describe("route histogram", () => {
  it("counts requests per bucket with bounds, and sums the percentiles from them", () => {
    const stats = new RouteStatistics(NOW - 120 * MINUTE);
    // 8 fast (0.5 ms -> bucket 0), 1 at 100 ms, 1 at 2000 ms, over two minutes.
    for (let i = 0; i < 8; i++) {
      stats.record("GET", "/a", 0.5, false, NOW - (i % 2) * MINUTE);
    }
    stats.record("GET", "/a", 100, false, NOW);
    stats.record("GET", "/a", 2000, true, NOW - MINUTE);
    // Another method and another route are not counted.
    stats.record("POST", "/a", 7000, false, NOW);
    stats.record("GET", "/b", 7000, false, NOW);
    currentSources = sources(stats);

    const body = hist("route=/a&method=GET");
    expect(body.method).toBe("GET");
    expect(body.count).toBe(10);
    expect(body.buckets).toHaveLength(HISTOGRAM_BUCKETS);
    expect(body.buckets[0]).toEqual({ fromMs: 0, toMs: 1, count: 8 });
    expect(
      body.buckets.reduce((n: number, b: { count: number }) => n + b.count, 0),
    ).toBe(10);
    const at = (ms: number) =>
      body.buckets.find(
        (b: { fromMs: number; toMs: number | null }) =>
          ms > b.fromMs && (b.toMs === null || ms <= b.toMs),
      );
    expect(at(100).count).toBe(1);
    expect(at(2000).count).toBe(1);
    expect(body.buckets.at(-1).toMs).toBeNull();
    // Bounds are contiguous.
    for (let i = 1; i < body.buckets.length; i++) {
      expect(body.buckets[i].fromMs).toBe(body.buckets[i - 1].toMs);
    }
    expect(body.p50Ms).toBeLessThanOrEqual(1);
    expect(body.p95Ms).toBeGreaterThan(body.p50Ms);
    expect(body.p99Ms).toBeGreaterThanOrEqual(body.p95Ms);
    expect(body.maxMs).toBe(2000);
    expect(body.p99Ms).toBeLessThanOrEqual(2000);
  });

  it("merges the methods of a route when no method is given, and answers zeros for an unknown route", () => {
    const stats = new RouteStatistics(NOW - 120 * MINUTE);
    stats.record("GET", "/a", 10, false, NOW);
    stats.record("POST", "/a", 10, false, NOW);
    currentSources = sources(stats);
    expect(hist("route=/a").count).toBe(2);
    expect(hist("route=/a").method).toBeNull();
    const none = hist("route=/zzz");
    expect(none.count).toBe(0);
    expect(none.p95Ms).toBe(0);
    expect(none.buckets.every((b: { count: number }) => b.count === 0)).toBe(
      true,
    );
  });

  it("honours the window: a request 30 minutes ago is in the 60-minute histogram only", () => {
    const stats = new RouteStatistics(NOW - 120 * MINUTE);
    stats.record("GET", "/a", 10, false, NOW - 30 * MINUTE);
    currentSources = sources(stats);
    expect(hist("route=/a").count).toBe(0);
    expect(hist("route=/a&windowMinutes=60").count).toBe(1);
  });

  it("requires a route, rejects bad parameters, and is empty for another service", () => {
    currentSources = sources(new RouteStatistics(NOW));
    const missing = routeHistogramHandler("/x?method=GET", currentSources, NOW);
    expect(missing.status).toBe(400);
    expect(
      routeHistogramHandler("/x?route=/a&windowMinutes=30", currentSources, NOW)
        .status,
    ).toBe(400);
    expect(
      routeHistogramHandler("/x?route=/a&nope=1", currentSources, NOW).status,
    ).toBe(400);
    const stats = new RouteStatistics(NOW - 120 * MINUTE);
    stats.record("GET", "/a", 10, false, NOW);
    currentSources = sources(stats);
    expect(hist("route=/a&service=shop").count).toBe(1);
    expect(hist("route=/a&service=other").count).toBe(0);
  });
});

describe("window comparison", () => {
  it("compares the last window with the one before, with deltas and union of routes", () => {
    const stats = new RouteStatistics(NOW - 120 * MINUTE);
    // Previous 15 minutes: minutes 15..29 ago. Current: 0..14 ago.
    for (let i = 0; i < 10; i++)
      stats.record("GET", "/a", 10, false, NOW - 20 * MINUTE);
    for (let i = 0; i < 10; i++)
      stats.record("GET", "/a", 100, i < 3, NOW - 5 * MINUTE);
    stats.record("GET", "/gone", 5, false, NOW - 20 * MINUTE);
    stats.record("GET", "/new", 5, false, NOW);
    currentSources = sources(stats);

    const body = compare("windowMinutes=15&previous=1");
    expect(body.mode).toBe("window");
    expect(body.previousCovered).toBe(true);
    expect(body.note).toBeNull();
    expect(body.current.toUnixMs).toBe(NOW);
    expect(body.previous.toUnixMs).toBe(body.current.fromUnixMs);
    expect(body.current.fromUnixMs - body.previous.fromUnixMs).toBe(
      15 * MINUTE,
    );
    const row = (route: string) =>
      body.routes.find((r: { route: string }) => r.route === route);
    const a = row("/a");
    expect(a.before).toMatchObject({ count: 10, errors: 0 });
    expect(a.after).toMatchObject({ count: 10, errors: 3 });
    expect(a.delta.count).toBe(0);
    expect(a.delta.errorRate).toBeCloseTo(0.3);
    expect(a.delta.p95Ms).toBeCloseTo(a.after.p95Ms - a.before.p95Ms, 3);
    expect(a.delta.p95Ms).toBeGreaterThan(50);
    // A route in one window only: counts delta, percentile deltas unknown.
    expect(row("/gone").after.count).toBe(0);
    expect(row("/gone").delta).toMatchObject({ count: -1, p95Ms: null });
    expect(row("/new").before.count).toBe(0);
    expect(row("/new").delta).toMatchObject({ count: 1, p50Ms: null });
    // Busiest in the current window first.
    expect(body.routes[0].route).toBe("/a");
  });

  it("says a 60-minute comparison is unavailable instead of inventing a previous hour", () => {
    const stats = new RouteStatistics(NOW - 240 * MINUTE);
    stats.record("GET", "/a", 10, false, NOW - 70 * MINUTE);
    stats.record("GET", "/a", 10, false, NOW - 5 * MINUTE);
    currentSources = sources(stats);
    const body = compare("windowMinutes=60");
    expect(body.previousCovered).toBe(false);
    expect(body.note).toMatch(/last 60 minutes/);
    expect(body.routes[0].before.count).toBe(0);
    expect(body.routes[0].after.count).toBe(1);
  });

  it("says when statistics started too recently to cover the previous window", () => {
    const stats = new RouteStatistics(NOW - 20 * MINUTE);
    stats.record("GET", "/a", 10, false, NOW);
    currentSources = sources(stats);
    const body = compare("windowMinutes=15");
    expect(body.previousCovered).toBe(false);
    expect(body.note).toMatch(/partly counted/);
  });

  it("deltaOf leaves percentile deltas null when a side is empty", () => {
    const side = { count: 4, errors: 1, p50Ms: 10, p95Ms: 20 };
    const none = { count: 0, errors: 0, p50Ms: 0, p95Ms: 0 };
    expect(deltaOf(side, none)).toEqual({
      count: -4,
      errorRate: -0.25,
      p50Ms: null,
      p95Ms: null,
    });
    expect(deltaOf(side, { ...side, p95Ms: 50 }).p95Ms).toBe(30);
  });
});

describe("release comparison and maxDurationMs", () => {
  function load(): ApiSources {
    const src = sources(new RouteStatistics(NOW - 120 * MINUTE), true);
    const processor = createStoreProcessor(src.store as never);
    let n = 1;
    const add = (
      release: string,
      route: string,
      durationMs: number,
      error = false,
      method = "GET",
    ) =>
      processor.onEnd(
        serverRoot(n++, {
          startMs: NOW - 1000 * n,
          durationMs,
          resource: { "service.name": "shop", "service.version": release },
          attributes: {
            "http.request.method": method,
            "http.route": route,
            "http.response.status_code": error ? 500 : 200,
          },
          ...(error ? { status: { code: 2, message: "boom" } } : {}),
        }),
      );
    // 1.0: /a at 10, 20, 30, 40 ms.
    for (const ms of [10, 20, 30, 40]) add("1.0", "/a", ms);
    // 1.1: /a at 100 and 200 ms (one error), and a route only it has.
    add("1.1", "/a", 100);
    add("1.1", "/a", 200, true);
    add("1.1", "/b", 5, false, "POST");
    add("0.9", "/a", 1);
    src.store?.drainNow();
    return src;
  }

  it("builds per-route count, error rate and nearest-rank percentiles from stored traces", () => {
    currentSources = load();
    const body = compare("releaseA=1.0&releaseB=1.1");
    expect(body.mode).toBe("release");
    expect(body.releaseA).toBe("1.0");
    expect(body.releases.sort()).toEqual(["0.9", "1.0", "1.1"]);
    const a = body.routes.find((r: { route: string }) => r.route === "/a");
    expect(a.before).toEqual({ count: 4, errors: 0, p50Ms: 20, p95Ms: 40 });
    expect(a.after).toEqual({ count: 2, errors: 1, p50Ms: 100, p95Ms: 200 });
    expect(a.delta).toEqual({
      count: -2,
      errorRate: 0.5,
      p50Ms: 80,
      p95Ms: 160,
    });
    const b = body.routes.find((r: { route: string }) => r.route === "/b");
    expect(b.method).toBe("POST");
    expect(b.before.count).toBe(0);
    expect(b.delta.p95Ms).toBeNull();
  });

  it("needs both releases, and answers empty for an unknown release or another service", () => {
    currentSources = load();
    expect(
      routeCompareHandler("/x?releaseA=1.0", currentSources, NOW).status,
    ).toBe(400);
    const unknown = compare("releaseA=nope&releaseB=nada");
    expect(unknown.routes).toEqual([]);
    expect(compare("releaseA=1.0&releaseB=1.1&service=other").routes).toEqual(
      [],
    );
  });

  it("filters the trace list by maxDurationMs, inclusive, together with minDurationMs", () => {
    currentSources = load();
    const list = (q: string) =>
      json(tracesHandler(`/x?${q}`, currentSources)).items.map(
        (t: { durationMs: number }) => t.durationMs,
      );
    expect(
      list("route=/a&maxDurationMs=30").sort((x: number, y: number) => x - y),
    ).toEqual([1, 10, 20, 30]);
    expect(
      list("route=/a&minDurationMs=20&maxDurationMs=100").sort(
        (x: number, y: number) => x - y,
      ),
    ).toEqual([20, 30, 40, 100]);
    expect(tracesHandler("/x?maxDurationMs=-1", currentSources).status).toBe(
      400,
    );
  });
});
