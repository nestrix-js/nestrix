// P11-01: `GET api/v1/overview` on the embedded dashboard. The handler is driven with real route
// statistics and a real store; one HTTP test checks the mounted route (shape, headers, closed
// without a token). No OpenTelemetry globals are touched in the handler tests.
import type { OverviewResponse } from "@nestrix-js/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ApiSources, overviewHandler } from "../src/dashboard/api.js";
import { resetDiagnosticsForTests } from "../src/diagnostics.js";
import { ClassStatistics } from "../src/stats/class-stats.js";
import { RouteStatistics } from "../src/stats/route-stats.js";
import { createStoreProcessor } from "../src/store/processor.js";
import { getOrCreateStore, resetStoreForTests } from "../src/store/store.js";
import {
  BEARER,
  bootDashboardApp,
  type DashboardApp,
  get,
  headerProblems,
  TOKEN,
} from "./dashboard-fixture.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import { fakeSpan, serverRoot, spanId } from "./store-helpers.js";

const MINUTE = 60_000;
const NOW = Math.floor(1_800_000_000_000 / MINUTE) * MINUTE + 30_000;

beforeEach(() => resetStoreForTests());
afterEach(() => resetStoreForTests());

function sources(stats: RouteStatistics, withStore: boolean): ApiSources {
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

const call = (src: ApiSources, query = ""): OverviewResponse => {
  const r = overviewHandler(`/x?${query}`, src, NOW);
  expect(r.status).toBe(200);
  return JSON.parse(r.body as string) as OverviewResponse;
};

/** A degraded app: /orders got slow and started failing, with traces to match. */
function degraded(): ApiSources {
  const stats = new RouteStatistics(NOW - 120 * MINUTE);
  for (let i = 0; i < 40; i++) {
    stats.record("GET", "/orders", 100, false, NOW - 20 * MINUTE + i * 1000);
  }
  for (let i = 0; i < 40; i++) {
    stats.record("GET", "/orders", 900, i < 10, NOW - 5 * MINUTE + i * 1000);
  }
  const src = sources(stats, true);
  const processor = createStoreProcessor(src.store as never);
  let n = 1;
  const ok = (startMs: number, release: string) => {
    const id = spanId();
    const trace = n++;
    // The database child ends first, as in a real trace.
    processor.onEnd(
      fakeSpan({
        trace,
        parent: { spanId: id },
        name: "SELECT",
        kind: 2,
        startMs: startMs + 5,
        durationMs: 30,
        attributes: { "db.system.name": "postgresql" },
        resource: { "service.name": "shop", "service.version": release },
      }),
    );
    processor.onEnd(
      serverRoot(trace, {
        id,
        startMs,
        durationMs: 100,
        resource: { "service.name": "shop", "service.version": release },
        attributes: {
          "http.request.method": "GET",
          "http.route": "/orders",
          "http.response.status_code": 200,
        },
      }),
    );
  };
  // One trace of release 1.0 in the previous window, three of 2.0 in the current one.
  ok(NOW - 20 * MINUTE, "1.0");
  for (let i = 0; i < 3; i++) ok(NOW - (5 - i) * MINUTE, "2.0");
  // Four failing requests of the same kind: one new error group.
  for (let i = 0; i < 4; i++) {
    processor.onEnd(
      serverRoot(n++, {
        startMs: NOW - 2 * MINUTE + i * 1000,
        durationMs: 50,
        status: { code: 2, message: "card declined" },
        resource: { "service.name": "shop", "service.version": "2.0" },
        attributes: {
          "http.request.method": "GET",
          "http.route": "/orders",
          "http.response.status_code": 500,
        },
      }),
    );
  }
  src.store?.drainNow();
  return src;
}

describe("overview handler (embedded)", () => {
  it("builds the answer from route statistics and the stored traces", () => {
    const body = call(degraded());
    expect(body.windowMinutes).toBe(15);
    expect(body.previousCovered).toBe(true);
    expect(body.note).toBeNull();
    expect(body.totals.count).toBe(40);
    expect(body.totals.errors).toBe(10);
    expect(body.previousTotals?.count).toBe(40);
    expect(body.previousTotals?.errors).toBe(0);
    expect(body.series).toHaveLength(15);
    expect(body.previousSeries).toHaveLength(15);

    const kinds = body.attention.map((i) => i.kind).sort();
    expect(kinds).toContain("route-latency");
    expect(kinds).toContain("route-errors");
    expect(kinds).toContain("error-group-new");
    const latency = body.attention.find((i) => i.kind === "route-latency");
    expect(latency?.title).toMatch(/^GET \/orders p95 \d+ ms → \d+ ms$/);
    expect(body.health.level).not.toBe("healthy");
    expect(body.health.summary).toMatch(/^\d+ things need attention: /);

    // Status mix of the stored roots in the window: 3 ok, 4 failed.
    expect(body.status).toEqual({
      ok: 3,
      redirect: 0,
      clientError: 0,
      serverError: 4,
    });
    expect(body.releases).toEqual([
      { version: "2.0", firstSeenUnixMs: expect.any(Number) },
    ]);
    // Own time of the database spans: 3 traces x 30 ms.
    const db = body.timeByKind.find((k) => k.key === "db");
    expect(db?.ms).toBeCloseTo(90);
    expect(db?.share).toBeGreaterThan(0);
    expect(body.timeByKind.reduce((s, k) => s + k.share, 0)).toBeCloseTo(1);
  });

  it("answers an app with no traffic and no store", () => {
    const body = call(sources(new RouteStatistics(NOW - 120 * MINUTE), false));
    expect(body.totals.count).toBe(0);
    expect(body.totals.apdex).toBeNull();
    expect(body.attention).toEqual([]);
    expect(body.health.summary).toBe("No requests in the last 15 minutes.");
    expect(body.timeByKind.every((k) => k.ms === 0)).toBe(true);
  });

  it("says the previous window is not covered when statistics are young, and for 60 minutes", () => {
    const young = new RouteStatistics(NOW - 5 * MINUTE);
    young.record("GET", "/a", 10, false, NOW - MINUTE);
    const body = call(sources(young, false));
    expect(body.previousCovered).toBe(false);
    expect(body.note).toMatch(/less than two windows/);
    expect(body.previousTotals).toBeNull();
    expect(body.previousSeries).toEqual([]);
    expect(body.totals.count).toBe(1);

    const hour = call(
      sources(new RouteStatistics(NOW - 300 * MINUTE), false),
      "windowMinutes=60&apdexMs=500",
    );
    expect(hour.previousCovered).toBe(false);
    expect(hour.bucketMs).toBe(2 * MINUTE);
    expect(hour.series).toHaveLength(30);
    expect(hour.apdexMs).toBe(500);
  });

  it("answers empty for another service and refuses bad parameters", () => {
    const src = degraded();
    const other = call(src, "service=billing");
    expect(other.totals.count).toBe(0);
    expect(other.attention).toEqual([]);
    expect(call(src, "service=shop").totals.count).toBe(40);
    for (const q of ["windowMinutes=30", "apdexMs=5", "nope=1"]) {
      expect(overviewHandler(`/x?${q}`, src, NOW).status).toBe(400);
    }
  });
});

let booted: DashboardApp | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
  resetDiagnosticsForTests();
});

describe("overview endpoint (express)", () => {
  it("serves a valid answer for counted requests, and is closed without a token", async () => {
    booted = await bootDashboardApp({
      adapter: "express",
      nestrix: {
        export: { otlp: false },
        ui: { enabled: true, auth: { token: TOKEN } },
      },
    });
    for (let i = 0; i < 5; i++) await get(`${booted.baseUrl}/h/ok`);
    const url = `${booted.baseUrl}/_nestrix/api/v1/overview`;

    const res = await get(`${url}?windowMinutes=15`, BEARER);
    expect(res.status).toBe(200);
    expect(headerProblems(res)).toEqual([]);
    const body = res.json() as OverviewResponse;
    expect(body.totals.count).toBe(5);
    expect(body.series).toHaveLength(15);
    expect(body.timeByKind).toHaveLength(6);
    expect(["healthy", "degraded", "critical"]).toContain(body.health.level);
    expect(typeof body.health.summary).toBe("string");
    expect(body.status.ok + body.status.serverError).toBeGreaterThanOrEqual(0);

    expect((await get(`${url}?windowMinutes=7`, BEARER)).status).toBe(400);
    expect((await get(url)).status).not.toBe(200);
  });
});
