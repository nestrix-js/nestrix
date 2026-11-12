// P15-01: the embedded classes, dependencies and map answers carry the previous window (the same
// length, just before the current one) as optional fields, or say why they cannot. Handlers are
// called directly with a fixed clock; no OpenTelemetry globals are touched.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ApiSources,
  classesHandler,
  dependenciesHandler,
  mapHandler,
} from "../src/dashboard/api.js";
import { ClassStatistics } from "../src/stats/class-stats.js";
import { RouteStatistics } from "../src/stats/route-stats.js";
import { createStoreProcessor } from "../src/store/processor.js";
import { getOrCreateStore, resetStoreForTests } from "../src/store/store.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import { fakeSpan, serverRoot } from "./store-helpers.js";

beforeEach(() => resetStoreForTests());
afterEach(() => resetStoreForTests());

const MIN = 60_000;
// A minute boundary, so the windows are easy to place.
const NOW = Math.floor(1_700_000_000_000 / MIN) * MIN + 30_000;
const PG = {
  "db.system.name": "postgresql",
  "server.address": "db",
  "db.namespace": "shop",
};

/** `since`: when statistics began, in minutes before NOW. */
function sources(sinceMinutes: number): ApiSources {
  const store = getOrCreateStore({}, recordingDiagnostics());
  store.attach({});
  const processor = createStoreProcessor(store);
  let trace = 0;
  const call = (atMinutesAgo: number, ms: number, error = false) => {
    const t = ++trace;
    const startMs = NOW - atMinutesAgo * MIN;
    const root = serverRoot(t, { startMs });
    processor.onEnd(root);
    processor.onEnd(
      fakeSpan({
        trace: t,
        parent: { spanId: root.spanContext().spanId },
        kind: 2,
        startMs: startMs + 1,
        durationMs: ms,
        attributes: PG,
        status: { code: error ? 2 : 0 },
      }),
    );
  };
  call(20, 40); // previous window (30 to 15 minutes ago)
  call(19, 80, true);
  call(2, 10); // current window
  store.drainNow();
  const since = NOW - sinceMinutes * MIN;
  const classes = new ClassStatistics(since);
  classes.recordAt(
    "OrdersService",
    "service",
    "place",
    100,
    false,
    NOW - 20 * MIN,
  );
  classes.recordAt(
    "OrdersService",
    "service",
    "place",
    300,
    true,
    NOW - 19 * MIN,
  );
  classes.recordAt("OldService", "service", "run", 7, false, NOW - 18 * MIN);
  classes.recordAt(
    "OrdersService",
    "service",
    "place",
    20,
    false,
    NOW - 2 * MIN,
  );
  return {
    store,
    stats: new RouteStatistics(since),
    classes,
    service: { name: "shop" },
    sampling: { owner: "nestrix", rate: 1 },
    hostOwnsProvider: false,
    ignoresRoutes: false,
    fallbackProcessId: "x",
  };
}

const body = (r: { body?: unknown }) => JSON.parse(r.body as string);

describe("classes", () => {
  it("adds the previous window per class and in the totals", () => {
    const r = body(classesHandler("/c", sources(60), NOW));
    expect(r.previousCovered).toBe(true);
    expect(r.note).toBeNull();
    expect(r.classes).toHaveLength(1);
    expect(r.classes[0]).toMatchObject({
      className: "OrdersService",
      calls: 1,
      previous: { calls: 2, errors: 1, totalMs: 400, avgMs: 200, ownMs: null },
    });
    expect(r.previousTotals).toEqual({
      classes: 2,
      calls: 3,
      errors: 1,
      totalMs: 407,
      ownMs: null,
    });
  });

  it("a 60 minute window has no previous window in the 60 minute ring, and says so", () => {
    const r = body(classesHandler("/c?windowMinutes=60", sources(120), NOW));
    expect(r.previousCovered).toBe(false);
    expect(r.note).toMatch(/last 60 minutes/);
    expect(r.previousTotals).toBeUndefined();
    expect(r.classes[0].previous).toBeUndefined();
    expect(r.classes[0].calls).toBe(3);
  });

  it("is not covered when statistics began less than two windows ago", () => {
    const r = body(classesHandler("/c", sources(20), NOW));
    expect(r.previousCovered).toBe(false);
    expect(r.note).toMatch(/less than two windows/);
    expect(r.previousTotals).toBeUndefined();
  });

  it("another service answers empty, with no previous totals", () => {
    const r = body(classesHandler("/c?service=other", sources(60), NOW));
    expect(r.classes).toEqual([]);
    expect(r.previousTotals).toBeUndefined();
  });
});

describe("dependencies", () => {
  it("adds the previous window per target and in the totals", () => {
    const r = body(dependenciesHandler("/d", sources(60), NOW));
    expect(r.previousCovered).toBe(true);
    expect(r.dependencies).toHaveLength(1);
    expect(r.dependencies[0]).toMatchObject({
      calls: 1,
      previous: { calls: 2, errors: 1, errorRate: 0.5, totalMs: 120 },
    });
    expect(r.previousTotals).toMatchObject({
      dependencies: 1,
      calls: 2,
      errors: 1,
    });
  });

  it("a 60 minute window is covered once statistics are two hours old", () => {
    expect(
      body(dependenciesHandler("/d?windowMinutes=60", sources(90), NOW))
        .previousCovered,
    ).toBe(false);
    expect(
      body(dependenciesHandler("/d?windowMinutes=60", sources(130), NOW))
        .previousCovered,
    ).toBe(true);
  });

  it("is not covered when statistics are young; another service is empty", () => {
    const young = body(dependenciesHandler("/d", sources(20), NOW));
    expect(young.previousCovered).toBe(false);
    expect(young.note).toMatch(/less than two windows/);
    expect(young.dependencies[0].previous).toBeUndefined();
    const other = body(
      dependenciesHandler("/d?service=other", sources(60), NOW),
    );
    expect(other.dependencies).toEqual([]);
    expect(other.previousTotals).toBeUndefined();
  });
});

describe("map", () => {
  it("adds the previous window per edge and in the totals", () => {
    const r = body(mapHandler("/m", sources(60), NOW));
    expect(r.previousCovered).toBe(true);
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]).toMatchObject({
      calls: 1,
      previous: { calls: 2, errors: 1 },
    });
    expect(r.previousTotals).toMatchObject({ targets: 1, calls: 2, errors: 1 });
  });

  it("is not covered when statistics are young; another service is empty", () => {
    const young = body(mapHandler("/m", sources(20), NOW));
    expect(young.previousCovered).toBe(false);
    expect(young.edges[0].previous).toBeUndefined();
    const other = body(mapHandler("/m?service=other", sources(60), NOW));
    expect(other.edges).toEqual([]);
    expect(other.previousTotals).toBeUndefined();
  });
});
