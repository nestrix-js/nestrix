// Dependencies and the request timeline (P9-05): synthetic spans through the store, then
// `buildDependencies` / `buildTimeline`.
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDependencies,
  buildDependenciesWithPrevious,
  buildTimeline,
} from "../src/store/dependencies.js";
import { createStoreProcessor } from "../src/store/processor.js";
import {
  getOrCreateStore,
  resetStoreForTests,
  type TraceStore,
} from "../src/store/store.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import { fakeSpan, serverRoot, traceId } from "./store-helpers.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const CLIENT = 2;
const ERROR = 2;

let store: TraceStore;
let ingest: (...spans: ReadableSpan[]) => void;
let trace = 0;

beforeEach(() => {
  resetStoreForTests();
  store = getOrCreateStore({}, recordingDiagnostics());
  store.attach({});
  const processor = createStoreProcessor(store);
  ingest = (...spans) => {
    for (const s of spans) processor.onEnd(s);
    store.drainNow();
  };
  trace = 0;
});
afterEach(() => {
  resetStoreForTests();
});

const PG = {
  "db.system.name": "postgresql",
  "server.address": "db.local",
  "server.port": 5432,
  "db.namespace": "shop",
};
const REDIS = { "db.system": "redis", "server.address": "cache.local" };

interface Call {
  attributes: Record<string, unknown>;
  ms: number;
  error?: boolean;
}

function request(
  startMs: number,
  opts: {
    status?: number;
    error?: boolean;
    route?: string;
    calls?: Call[];
  } = {},
): string {
  const t = ++trace;
  const root = serverRoot(t, {
    id: `${t.toString(16).padStart(8, "0")}00000000`,
    startMs,
    attributes: {
      "http.request.method": "GET",
      "http.route": opts.route ?? "/items",
      "http.response.status_code": opts.status ?? 200,
    },
    ...(opts.error ? { status: { code: ERROR } } : {}),
  });
  ingest(
    root,
    ...(opts.calls ?? []).map((c) =>
      fakeSpan({
        trace: t,
        parent: { spanId: root.spanContext().spanId },
        kind: CLIENT,
        startMs: startMs + 1,
        durationMs: c.ms,
        attributes: c.attributes,
        status: { code: c.error ? ERROR : 0 },
      }),
    ),
  );
  return traceId(t);
}

describe("buildDependencies", () => {
  it("aggregates calls per target, sorts by total time and buckets by minute", () => {
    const slow = request(NOW - 3 * MIN + 10, {
      calls: [
        { attributes: PG, ms: 100 },
        { attributes: PG, ms: 300, error: true },
      ],
    });
    request(NOW - 1 * MIN + 10, {
      calls: [
        { attributes: PG, ms: 200 },
        { attributes: REDIS, ms: 1 },
      ],
    });
    const r = buildDependencies(store, 15, NOW);
    expect(r.bucketMs).toBe(MIN);
    expect(r.dependencies.map((d) => d.id)).toEqual([
      "db:postgresql:db.local:5432/shop",
      "cache:redis:cache.local",
    ]);
    const pg = r.dependencies[0];
    expect(pg).toMatchObject({
      kind: "database",
      name: "postgresql shop",
      calls: 3,
      errors: 1,
      totalMs: 600,
      p50Ms: 200,
      p95Ms: 300,
      exampleTraceId: slow,
    });
    expect(pg?.errorRate).toBeCloseTo(1 / 3);
    expect(pg?.series).toHaveLength(15);
    expect(pg?.series.reduce((n, p) => n + p.calls, 0)).toBe(3);
    const busy = pg?.series.filter((p) => p.calls > 0);
    expect(busy?.map((p) => [p.calls, p.p95Ms])).toEqual([
      [2, 300],
      [1, 200],
    ]);
    expect(pg?.series.at(-1)?.startUnixMs).toBe(Math.floor(NOW / MIN) * MIN);
  });

  it("uses 5 minute buckets for a 60 minute window and ignores older traces", () => {
    request(NOW - 30 * MIN, { calls: [{ attributes: PG, ms: 10 }] });
    request(NOW - 90 * MIN, { calls: [{ attributes: PG, ms: 10 }] });
    const r = buildDependencies(store, 60, NOW);
    expect(r.bucketMs).toBe(5 * MIN);
    expect(r.dependencies[0]?.calls).toBe(1);
    expect(r.dependencies[0]?.series).toHaveLength(12);
  });

  it("is empty without a store", () => {
    expect(buildDependencies(undefined, 15, NOW).dependencies).toEqual([]);
  });
});

describe("buildTimeline", () => {
  it("splits ok, 4xx and 5xx-or-error per bucket", () => {
    request(NOW - 2 * MIN + 5);
    request(NOW - 2 * MIN + 6, { status: 404 });
    request(NOW - 2 * MIN + 7, { status: 503 });
    request(NOW - 1 * MIN + 5, { error: true });
    request(NOW - 1 * MIN + 6);
    const r = buildTimeline(store, 15, NOW, {});
    expect(r.buckets).toHaveLength(15);
    const traffic = r.buckets.filter(
      (b) => b.ok + b.clientError + b.serverError > 0,
    );
    expect(traffic.map((b) => [b.ok, b.clientError, b.serverError])).toEqual([
      [1, 1, 1],
      [1, 0, 1],
    ]);
  });

  it("applies the list filters", () => {
    request(NOW - MIN + 5, { route: "/a" });
    request(NOW - MIN + 6, { route: "/b", status: 500 });
    const sum = (
      r: ReturnType<typeof buildTimeline>,
      k: "ok" | "serverError",
    ) => r.buckets.reduce((n, b) => n + b[k], 0);
    const only = buildTimeline(store, 15, NOW, { route: "/b" });
    expect([sum(only, "serverError"), sum(only, "ok")]).toEqual([1, 0]);
    const failing = buildTimeline(store, 15, NOW, { status: "5xx" });
    expect([sum(failing, "serverError"), sum(failing, "ok")]).toEqual([1, 0]);
  });
});

describe("trace list time range", () => {
  it("keeps roots between fromUnixMs and toUnixMs", () => {
    request(NOW - 10 * MIN);
    const mid = request(NOW - 5 * MIN);
    request(NOW - 1 * MIN);
    const page = store.listTraces({
      limit: 50,
      fromUnixMs: NOW - 6 * MIN,
      toUnixMs: NOW - 4 * MIN,
    });
    expect(page.items.map((i) => i.traceId)).toEqual([mid]);
  });
});

describe("buildDependenciesWithPrevious", () => {
  it("attaches the previous window's numbers per target and the totals", () => {
    // Previous window: 30 to 15 minutes ago. PG: 2 calls (1 error); redis only then; stripe not.
    request(NOW - 20 * MIN, {
      calls: [
        { attributes: PG, ms: 100 },
        { attributes: PG, ms: 400, error: true },
        { attributes: REDIS, ms: 5 },
      ],
    });
    // Current window: PG once, and a target that is new.
    request(NOW - 2 * MIN, {
      calls: [
        { attributes: PG, ms: 50 },
        {
          attributes: {
            "server.address": "api.stripe.com",
            "http.request.method": "GET",
          },
          ms: 10,
        },
      ],
    });
    const r = buildDependenciesWithPrevious(store, 15, NOW, 0);
    expect(r.previousCovered).toBe(true);
    expect(r.note).toBeNull();
    const pg = r.dependencies.find((d) => d.id.startsWith("db:"));
    expect(pg?.calls).toBe(1);
    expect(pg?.previous).toEqual({
      calls: 2,
      errors: 1,
      errorRate: 0.5,
      totalMs: 500,
      p50Ms: 100,
      p95Ms: 400,
    });
    // New in this window: no `previous`. Gone: counted in the totals only.
    expect(
      r.dependencies.find((d) => d.id === "http:api.stripe.com")?.previous,
    ).toBeUndefined();
    expect(r.dependencies.map((d) => d.id)).not.toContain(
      "cache:redis:cache.local",
    );
    expect(r.previousTotals).toEqual({
      dependencies: 2,
      calls: 3,
      errors: 1,
      slowestP95Ms: 400,
    });
    // The current numbers are those of buildDependencies.
    expect(r.dependencies.map((d) => ({ ...d, previous: undefined }))).toEqual(
      buildDependencies(store, 15, NOW).dependencies.map((d) => ({
        ...d,
        previous: undefined,
      })),
    );
  });

  it("says the previous window is not covered when statistics began later", () => {
    request(NOW - 20 * MIN, { calls: [{ attributes: PG, ms: 100 }] });
    request(NOW - 2 * MIN, { calls: [{ attributes: PG, ms: 50 }] });
    const r = buildDependenciesWithPrevious(store, 15, NOW, NOW - 10 * MIN);
    expect(r.previousCovered).toBe(false);
    expect(r.note).toMatch(/less than two windows/);
    expect(r.previousTotals).toBeUndefined();
    expect(r.dependencies[0]?.previous).toBeUndefined();
    expect(r.dependencies[0]?.calls).toBe(1);
  });

  it("works without a store", () => {
    const r = buildDependenciesWithPrevious(undefined, 15, NOW, 0);
    expect(r).toMatchObject({
      previousCovered: true,
      dependencies: [],
      previousTotals: { dependencies: 0, calls: 0, errors: 0, slowestP95Ms: 0 },
    });
  });
});
