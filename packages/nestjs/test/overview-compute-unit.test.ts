// P11-01: the pure Overview computation, with hand-built inputs. `apps/server/src/query/overview-compute.ts`
// is a copy of the module under test; the server has the same file comparison and route tests.
import type {
  DependencyStats,
  ErrorGroup,
  Insight,
  OverviewTotals,
} from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";
import {
  apdexOf,
  computeOverview,
  dependencyErrorSeverity,
  dependencyLatencyVerdict,
  errorRateVerdict,
  formatMs,
  HISTOGRAM_BUCKETS,
  HISTOGRAM_UPPER_BOUNDS_MS,
  healthOf,
  latencyVerdict,
  MINUTE_MS,
  type MinuteRow,
  newGroupSeverity,
  type OverviewInput,
  quantileOf,
  sloSeverity,
  spikeSeverity,
  timeKeyOf,
} from "../src/overview/compute.js";

const NOW = Math.floor(1_800_000_000_000 / MINUTE_MS) * MINUTE_MS + 30_000;
const LAST = Math.floor(NOW / MINUTE_MS);
const CUR_FIRST = LAST - 15 + 1;
const PREV_FIRST = CUR_FIRST - 15;
const CUR_FROM = CUR_FIRST * MINUTE_MS;

/** The histogram bucket whose range holds `ms`. */
function bucketOf(ms: number): number {
  for (let i = 0; i < HISTOGRAM_BUCKETS - 1; i++) {
    if (ms <= (HISTOGRAM_UPPER_BOUNDS_MS[i] as number)) return i;
  }
  return HISTOGRAM_BUCKETS - 1;
}

/** One minute of one route: `count` requests of about `ms` (in one bucket), `errors` of them failed. */
function row(
  minute: number,
  route: string,
  count: number,
  ms: number,
  errors = 0,
  method = "GET",
): MinuteRow {
  const hist = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
  hist[bucketOf(ms)] = count;
  return { minute, method, route, count, errors, max: ms, hist };
}

function input(overrides: Partial<OverviewInput> = {}): OverviewInput {
  return {
    nowUnixMs: NOW,
    windowMinutes: 15,
    apdexMs: 300,
    previousCovered: true,
    note: null,
    rows: [],
    status: { ok: 0, redirect: 0, clientError: 0, serverError: 0 },
    kinds: [],
    previousKinds: null,
    releases: [],
    errorGroups: { current: [], previous: [] },
    dependencies: { current: [], previous: [] },
    ...overrides,
  };
}

function group(overrides: Partial<ErrorGroup> = {}): ErrorGroup {
  return {
    key: "k",
    errorType: "PaymentGatewayError",
    pattern: "card <n> declined",
    route: "/orders",
    count: 10,
    firstSeenUnixMs: CUR_FROM + 60_000,
    lastSeenUnixMs: NOW - 1000,
    series: new Array<number>(15).fill(1),
    services: [],
    exampleTraceId: "t",
    recent: [],
    ...overrides,
  };
}

function dep(overrides: Partial<DependencyStats> = {}): DependencyStats {
  return {
    id: "http:api.stripe.com",
    kind: "http",
    name: "api.stripe.com",
    calls: 50,
    errors: 0,
    errorRate: 0,
    totalMs: 1000,
    p50Ms: 100,
    p95Ms: 400,
    series: [
      { startUnixMs: CUR_FROM, calls: 5, p95Ms: 400 },
      { startUnixMs: CUR_FROM + 60_000, calls: 5, p95Ms: 900 },
    ],
    ...overrides,
  };
}

describe("rule boundaries", () => {
  it("route latency: fires at 1.2x and +50 ms, not just under either", () => {
    expect(latencyVerdict(250, 300, 50)).toEqual({
      direction: "worse",
      severity: "medium",
    });
    // 1.2x but only +40 ms.
    expect(latencyVerdict(200, 240, 50)).toBeUndefined();
    // +50 ms but only 1.19x.
    expect(latencyVerdict(300, 357, 50)).toBeUndefined();
    expect(latencyVerdict(300, 360, 50)?.direction).toBe("worse");
    expect(latencyVerdict(0, 500, 50)).toBeUndefined();
  });

  it("route latency: high needs 1.5x and 100 requests", () => {
    expect(latencyVerdict(200, 300, 100)?.severity).toBe("high");
    expect(latencyVerdict(200, 300, 99)?.severity).toBe("medium");
    expect(latencyVerdict(200, 299, 500)?.severity).toBe("medium");
  });

  it("route latency: better at 0.8x and -30 ms", () => {
    expect(latencyVerdict(200, 160, 50)).toEqual({
      direction: "better",
      severity: "low",
    });
    // 0.8x but only -20 ms.
    expect(latencyVerdict(100, 80, 50)).toBeUndefined();
    // -30 ms but 0.83x.
    expect(latencyVerdict(180, 150, 50)).toBeUndefined();
  });

  it("route errors: 1 point and 5 errors worse, 5 points high, 1 point better", () => {
    expect(errorRateVerdict(0.01, 0.02, 5)).toEqual({
      direction: "worse",
      severity: "medium",
    });
    expect(errorRateVerdict(0.01, 0.0199, 5)).toBeUndefined();
    expect(errorRateVerdict(0.01, 0.02, 4)).toBeUndefined();
    expect(errorRateVerdict(0, 0.05, 10)?.severity).toBe("high");
    expect(errorRateVerdict(0, 0.0499, 10)?.severity).toBe("medium");
    expect(errorRateVerdict(0.05, 0.04, 0)).toEqual({
      direction: "better",
      severity: "low",
    });
    expect(errorRateVerdict(0.05, 0.0401, 0)).toBeUndefined();
  });

  it("new error group: 3 events, high at 50", () => {
    expect(newGroupSeverity(2)).toBeUndefined();
    expect(newGroupSeverity(3)).toBe("medium");
    expect(newGroupSeverity(49)).toBe("medium");
    expect(newGroupSeverity(50)).toBe("high");
  });

  it("error group spike: 3x and 10 events, high at 10x", () => {
    expect(spikeSeverity(4, 12)).toBe("medium");
    expect(spikeSeverity(4, 11)).toBeUndefined();
    expect(spikeSeverity(5, 9)).toBeUndefined();
    expect(spikeSeverity(1, 10)).toBe("high");
    expect(spikeSeverity(2, 19)).toBe("medium");
    expect(spikeSeverity(2, 20)).toBe("high");
  });

  it("dependency latency: 1.3x and +50 ms, high at 2x, better at 0.75x and -30 ms", () => {
    expect(dependencyLatencyVerdict(400, 520)).toEqual({
      direction: "worse",
      severity: "medium",
    });
    expect(dependencyLatencyVerdict(400, 519)).toBeUndefined();
    // 1.3x but only +39 ms.
    expect(dependencyLatencyVerdict(130, 169)).toBeUndefined();
    expect(dependencyLatencyVerdict(400, 800)?.severity).toBe("high");
    expect(dependencyLatencyVerdict(400, 799)?.severity).toBe("medium");
    expect(dependencyLatencyVerdict(400, 300)).toEqual({
      direction: "better",
      severity: "low",
    });
    expect(dependencyLatencyVerdict(400, 301)).toBeUndefined();
    // 0.75x but only -15 ms.
    expect(dependencyLatencyVerdict(60, 45)).toBeUndefined();
  });

  it("dependency errors: 2 points and 5 errors, high at 10 points", () => {
    expect(dependencyErrorSeverity(0, 0.02, 5)).toBe("medium");
    expect(dependencyErrorSeverity(0, 0.0199, 5)).toBeUndefined();
    expect(dependencyErrorSeverity(0, 0.02, 4)).toBeUndefined();
    expect(dependencyErrorSeverity(0, 0.1, 10)).toBe("high");
    expect(dependencyErrorSeverity(0, 0.0999, 10)).toBe("medium");
  });

  it("slo burn: above 1 medium, above 2 high", () => {
    expect(sloSeverity(1)).toBeUndefined();
    expect(sloSeverity(null)).toBeUndefined();
    expect(sloSeverity(1.01)).toBe("medium");
    expect(sloSeverity(2)).toBe("medium");
    expect(sloSeverity(2.01)).toBe("high");
  });
});

describe("computeOverview insights", () => {
  const slowdown = (before: number, after: number, n = 120) => [
    row(PREV_FIRST + 1, "/orders", n, before),
    row(CUR_FIRST + 1, "/orders", n, after),
  ];

  it("lists a slower route under needs attention with the formatted title, impact and series", () => {
    const out = computeOverview(input({ rows: slowdown(100, 400) }));
    expect(out.attention).toHaveLength(1);
    const i = out.attention[0];
    expect(i?.kind).toBe("route-latency");
    expect(i?.severity).toBe("high");
    expect(i?.title).toMatch(/^GET \/orders p95 \d+ ms → \d+ ms$/);
    expect(i?.unit).toBe("ms");
    expect(i?.source).toBe("stats");
    expect(i?.link).toEqual({
      view: "route",
      params: { route: "/orders", method: "GET" },
    });
    expect(i?.series).toHaveLength(15);
    expect(i?.series[1]).toBeGreaterThan(0);
    expect(i?.series[0]).toBe(0);
    const change = i?.change as number;
    expect(i?.impact).toBeCloseTo(120 * Math.min(Math.abs(change), 10));
    expect(out.better).toEqual([]);
  });

  it("lists a faster route under getting better", () => {
    const out = computeOverview(input({ rows: slowdown(400, 100) }));
    expect(out.attention).toEqual([]);
    expect(out.better[0]?.kind).toBe("route-latency");
    expect(out.better[0]?.severity).toBe("low");
    expect(out.better[0]?.direction).toBe("better");
  });

  it("ignores a route with fewer than 20 requests in either window", () => {
    expect(
      computeOverview(input({ rows: slowdown(100, 900, 19) })).attention,
    ).toEqual([]);
    expect(
      computeOverview(
        input({
          rows: [
            row(PREV_FIRST + 1, "/orders", 19, 100),
            row(CUR_FIRST + 1, "/orders", 200, 900),
          ],
        }),
      ).attention,
    ).toEqual([]);
    expect(
      computeOverview(input({ rows: slowdown(100, 900, 20) })).attention,
    ).toHaveLength(1);
  });

  it("flags a route whose error rate rose and one whose rate fell", () => {
    const out = computeOverview(
      input({
        rows: [
          row(PREV_FIRST + 1, "/a", 100, 50, 0),
          row(CUR_FIRST + 1, "/a", 100, 50, 10),
          row(PREV_FIRST + 1, "/b", 100, 50, 10),
          row(CUR_FIRST + 1, "/b", 100, 50, 0),
        ],
      }),
    );
    expect(out.attention.map((i) => i.id)).toEqual(["route-errors:GET /a"]);
    expect(out.attention[0]?.title).toBe("GET /a error rate 0.0% → 10.0%");
    expect(out.attention[0]?.severity).toBe("high");
    expect(out.attention[0]?.change).toBeNull();
    expect(out.attention[0]?.impact).toBe(10);
    expect(out.better.map((i) => i.id)).toEqual(["route-errors:GET /b"]);
    expect(out.better[0]?.series[1]).toBe(0);
  });

  it("flags a new error group, a spike and a cleared group; a new one needs no previous window", () => {
    const spiking = group({ key: "s", pattern: "spike", count: 40 });
    const cleared = group({
      key: "c",
      pattern: "gone",
      count: 2,
      lastSeenUnixMs: CUR_FROM + 60_000,
    });
    const fresh = group({ key: "n", pattern: "fresh", count: 214 });
    const previous = [
      group({ key: "s", pattern: "spike", count: 4 }),
      group({ key: "c", pattern: "gone", count: 30 }),
    ];
    const out = computeOverview(
      input({ errorGroups: { current: [fresh, spiking, cleared], previous } }),
    );
    // The spike (40 events, x9) outweighs the new group (214 events, x1).
    expect(out.attention.map((i) => i.kind)).toEqual([
      "error-group-spike",
      "error-group-new",
    ]);
    expect(out.attention[0]?.severity).toBe("high");
    expect(out.attention[0]?.title).toBe(
      "PaymentGatewayError spiked 4 → 40 events",
    );
    expect(out.attention[1]?.title).toBe(
      "PaymentGatewayError is new (214 events)",
    );
    expect(out.attention[1]?.severity).toBe("high");
    expect(out.attention[1]?.before).toBeNull();
    expect(out.better).toHaveLength(1);
    expect(out.better[0]?.title).toBe(
      "PaymentGatewayError cleared (was 30 events)",
    );
    expect(out.better[0]?.severity).toBe("low");

    const uncovered = computeOverview(
      input({
        previousCovered: false,
        errorGroups: { current: [fresh, spiking, cleared], previous: [] },
      }),
    );
    // `cleared` has 2 events: too few to be new.
    expect(uncovered.attention.map((i) => i.id)).toHaveLength(2);
    expect(uncovered.attention.every((i) => i.kind === "error-group-new")).toBe(
      true,
    );
    expect(uncovered.better).toEqual([]);
  });

  it("does not call a group new when it has fewer than 3 events or began before the window", () => {
    const out = computeOverview(
      input({
        errorGroups: {
          current: [
            group({ key: "a", count: 2 }),
            group({ key: "b", pattern: "old", firstSeenUnixMs: CUR_FROM - 1 }),
          ],
          previous: [],
        },
      }),
    );
    expect(out.attention).toEqual([]);
  });

  it("flags dependency latency and errors, with calls guarding against noise", () => {
    const out = computeOverview(
      input({
        dependencies: {
          current: [
            dep({ p95Ms: 1100, errors: 10, errorRate: 0.2 }),
            dep({ id: "http:few", name: "few", calls: 9, p95Ms: 5000 }),
          ],
          previous: [
            dep({ p95Ms: 640 }),
            dep({ id: "http:few", name: "few", calls: 50, p95Ms: 100 }),
          ],
        },
      }),
    );
    expect(out.attention.map((i) => i.kind).sort()).toEqual([
      "dependency-errors",
      "dependency-latency",
    ]);
    const latency = out.attention.find((i) => i.kind === "dependency-latency");
    expect(latency?.title).toBe("api.stripe.com p95 640 ms → 1.1 s");
    expect(latency?.severity).toBe("medium");
    expect(latency?.series).toEqual([400, 900]);
    expect(latency?.source).toBe("traces");
  });

  it("flags a burning SLO and ignores one within budget", () => {
    const out = computeOverview(
      input({
        slos: [
          { id: "1", name: "checkout", burnRate1h: 3.2, badRequests: 80 },
          { id: "2", name: "search", burnRate1h: 0.4, badRequests: 1 },
          { id: "3", name: "idle", burnRate1h: null, badRequests: 0 },
        ],
      }),
    );
    expect(out.attention).toHaveLength(1);
    expect(out.attention[0]?.kind).toBe("slo-burn");
    expect(out.attention[0]?.severity).toBe("high");
    expect(out.attention[0]?.impact).toBe(80);
    expect(out.attention[0]?.link.view).toBe("slos");
  });

  it("sorts by impact and keeps at most 6 in each list", () => {
    const rows: MinuteRow[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(row(PREV_FIRST + 1, `/r${i}`, 100 + i * 10, 100));
      rows.push(row(CUR_FIRST + 1, `/r${i}`, 100 + i * 10, 400));
    }
    const out = computeOverview(input({ rows }));
    expect(out.attention).toHaveLength(6);
    const impacts = out.attention.map((i) => i.impact);
    expect(impacts).toEqual([...impacts].sort((a, b) => b - a));
    expect(out.attention[0]?.id).toBe("route-latency:GET /r7");
  });

  it("produces no insight that needs a before when the previous window is not covered", () => {
    const out = computeOverview(
      input({
        previousCovered: false,
        note: "no history",
        rows: slowdown(100, 900),
        dependencies: {
          current: [dep({ p95Ms: 1100 })],
          previous: [dep({ p95Ms: 400 })],
        },
      }),
    );
    expect(out.attention).toEqual([]);
    expect(out.previousCovered).toBe(false);
    expect(out.note).toBe("no history");
    expect(out.previousTotals).toBeNull();
    expect(out.previousSeries).toEqual([]);
    // The current window is still counted.
    expect(out.totals.count).toBe(120);
  });
});

describe("computeOverview totals and series", () => {
  it("merges routes into totals, percentiles and a per-minute rate", () => {
    const out = computeOverview(
      input({
        rows: [
          row(CUR_FIRST + 2, "/a", 60, 50, 3),
          row(CUR_FIRST + 3, "/b", 30, 50, 0),
          row(PREV_FIRST + 2, "/a", 15, 50, 1),
        ],
      }),
    );
    expect(out.totals.count).toBe(90);
    expect(out.totals.errors).toBe(3);
    expect(out.totals.errorRate).toBeCloseTo(3 / 90);
    expect(out.totals.perMinute).toBe(6);
    expect(out.totals.p95Ms).toBeGreaterThan(0);
    expect(out.totals.p50Ms).toBeLessThanOrEqual(out.totals.p95Ms);
    expect(out.previousTotals?.count).toBe(15);
    expect(out.previousTotals?.perMinute).toBe(1);
    expect(out.current).toEqual({ fromUnixMs: CUR_FROM, toUnixMs: NOW });
    expect(out.previous).toEqual({
      fromUnixMs: PREV_FIRST * MINUTE_MS,
      toUnixMs: CUR_FROM,
    });
  });

  it("builds one point per minute for 15 minutes and 2-minute points for 60, aligned to previous", () => {
    const small = computeOverview(
      input({ rows: [row(CUR_FIRST + 4, "/a", 10, 50)] }),
    );
    expect(small.bucketMs).toBe(MINUTE_MS);
    expect(small.series).toHaveLength(15);
    expect(small.series[4]?.count).toBe(10);
    expect(small.series[4]?.p95Ms).toBeGreaterThan(0);
    expect(small.series[3]).toEqual({
      timeUnixMs: (CUR_FIRST + 3) * MINUTE_MS,
      count: 0,
      errors: 0,
    });
    expect(small.previousSeries).toHaveLength(15);
    expect(small.previousSeries[0]?.timeUnixMs).toBe(PREV_FIRST * MINUTE_MS);

    const first60 = LAST - 60 + 1;
    const big = computeOverview(
      input({
        windowMinutes: 60,
        previousCovered: false,
        rows: [row(first60 + 5, "/a", 7, 50), row(first60 + 4, "/a", 3, 50)],
      }),
    );
    expect(big.bucketMs).toBe(2 * MINUTE_MS);
    expect(big.series).toHaveLength(30);
    // Minutes 4 and 5 share the third bucket.
    expect(big.series[2]?.count).toBe(10);
    expect(big.previousSeries).toEqual([]);
  });

  it("answers an empty window with zeros and a null Apdex", () => {
    const out = computeOverview(input());
    expect(out.totals).toMatchObject({
      count: 0,
      errors: 0,
      errorRate: 0,
      p95Ms: 0,
      apdex: null,
    });
    expect(out.health.summary).toBe("No requests in the last 15 minutes.");
    expect(out.health.score).toBe(100);
  });

  it("counts the time by kind with shares and the previous share", () => {
    const facts = (over: object) => ({
      kind: "internal",
      dbSystem: undefined,
      messaging: false,
      http: false,
      nest: false,
      ...over,
    });
    const out = computeOverview(
      input({
        kinds: [
          { facts: facts({ kind: "client", dbSystem: "postgresql" }), ms: 600 },
          { facts: facts({ kind: "client", dbSystem: "redis" }), ms: 100 },
          { facts: facts({ kind: "client", http: true }), ms: 200 },
          { facts: facts({ nest: true }), ms: 100 },
        ],
        previousKinds: [
          { facts: facts({ kind: "client", dbSystem: "postgresql" }), ms: 100 },
          { facts: facts({ nest: true }), ms: 100 },
        ],
        status: { ok: 5, redirect: 1, clientError: 2, serverError: 3 },
        releases: [{ version: "1.8.2", firstSeenUnixMs: CUR_FROM }],
      }),
    );
    const by = Object.fromEntries(out.timeByKind.map((k) => [k.key, k]));
    expect(out.timeByKind.map((k) => k.key)).toEqual([
      "db",
      "http-out",
      "redis",
      "messaging",
      "app",
      "other",
    ]);
    expect(by.db?.ms).toBe(600);
    expect(by.db?.share).toBeCloseTo(0.6);
    expect(by.db?.previousShare).toBeCloseTo(0.5);
    expect(by["http-out"]?.share).toBeCloseTo(0.2);
    expect(by.redis?.share).toBeCloseTo(0.1);
    expect(by.app?.share).toBeCloseTo(0.1);
    expect(by.messaging?.share).toBe(0);
    expect(out.status).toEqual({
      ok: 5,
      redirect: 1,
      clientError: 2,
      serverError: 3,
    });
    expect(out.releases).toEqual([
      { version: "1.8.2", firstSeenUnixMs: CUR_FROM },
    ]);

    const noPrevious = computeOverview(input({ kinds: [facts0(100)] }));
    expect(noPrevious.timeByKind.every((k) => k.previousShare === null)).toBe(
      true,
    );
  });

  it("classifies spans by kind", () => {
    const f = (over: object) => ({
      kind: "internal",
      dbSystem: undefined,
      messaging: false,
      http: false,
      nest: false,
      ...over,
    });
    expect(timeKeyOf(f({ dbSystem: "mysql" }))).toBe("db");
    expect(timeKeyOf(f({ dbSystem: "valkey" }))).toBe("redis");
    expect(timeKeyOf(f({ kind: "producer" }))).toBe("messaging");
    expect(timeKeyOf(f({ kind: "client", messaging: true }))).toBe("messaging");
    expect(timeKeyOf(f({ kind: "client", http: true }))).toBe("http-out");
    expect(timeKeyOf(f({ kind: "server", http: true }))).toBe("other");
    expect(timeKeyOf(f({ nest: true }))).toBe("app");
    expect(timeKeyOf(f({}))).toBe("other");
  });
});

function facts0(ms: number) {
  return {
    facts: {
      kind: "internal",
      dbSystem: undefined,
      messaging: false,
      http: false,
      nest: false,
    },
    ms,
  };
}

describe("Apdex from histograms", () => {
  it("counts a bucket by its upper edge, and errors as frustrated", () => {
    const hist = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
    // T = 300 ms: bucket edges at or below 300 are satisfied, up to 1200 tolerating.
    hist[bucketOf(100)] = 80;
    hist[bucketOf(800)] = 15;
    hist[bucketOf(5000)] = 5;
    const plain = apdexOf(hist, 100, 0, 300);
    expect(plain).toEqual({ satisfied: 80, tolerating: 15, frustrated: 5 });
    const withErrors = apdexOf(hist, 100, 10, 300);
    expect(withErrors.satisfied).toBe(72);
    expect(withErrors.tolerating).toBe(14);
    expect(withErrors.frustrated).toBe(14);
    expect(
      withErrors.satisfied + withErrors.tolerating + withErrors.frustrated,
    ).toBe(100);
  });

  it("puts the overflow bucket in frustrated and reports the score in the totals", () => {
    const out = computeOverview(
      input({
        rows: [
          row(CUR_FIRST + 1, "/a", 80, 100),
          row(CUR_FIRST + 2, "/a", 15, 800),
          row(CUR_FIRST + 3, "/a", 5, 90_000),
        ],
      }),
    );
    expect(out.totals.satisfied).toBe(80);
    expect(out.totals.tolerating).toBe(15);
    expect(out.totals.frustrated).toBe(5);
    expect(out.totals.apdex).toBeCloseTo((80 + 7.5) / 100);
    expect(out.apdexMs).toBe(300);
    // A larger T moves the 800 ms requests to satisfied (their bucket's upper edge is under T).
    const t = computeOverview(
      input({ apdexMs: 2000, rows: [row(CUR_FIRST + 1, "/a", 10, 800)] }),
    );
    expect(t.totals.apdex).toBe(1);
  });

  it("estimates percentiles inside the bucket and never above the maximum", () => {
    const hist = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
    hist[bucketOf(100)] = 10;
    expect(quantileOf(hist, 10, 0.95, 100)).toBeLessThanOrEqual(100);
    expect(quantileOf(hist, 0, 0.95, 0)).toBe(0);
  });
});

describe("health", () => {
  const totals = (over: Partial<OverviewTotals> = {}): OverviewTotals => ({
    count: 1000,
    errors: 0,
    errorRate: 0,
    p50Ms: 10,
    p95Ms: 50,
    p99Ms: 90,
    perMinute: 66,
    apdex: 1,
    satisfied: 1000,
    tolerating: 0,
    frustrated: 0,
    ...over,
  });
  const item = (severity: "high" | "medium" | "low", title: string): Insight =>
    ({
      id: title,
      kind: "route-latency",
      direction: "worse",
      severity,
      title,
      detail: "",
      before: 1,
      after: 2,
      unit: "ms",
      change: 1,
      impact: 1,
      series: [],
      source: "stats",
      link: { view: "route", params: {} },
    }) satisfies Insight;

  it("scores 100 with nothing wrong and says so", () => {
    expect(healthOf([], [], totals(), 15)).toEqual({
      score: 100,
      level: "healthy",
      summary: "No problems found.",
    });
  });

  it("subtracts 12 per high and 6 per medium, up to 30 for errors and the Apdex shortfall", () => {
    const h = healthOf(
      [item("high", "A"), item("medium", "B")],
      [],
      totals({ errorRate: 0.01, apdex: 0.9 }),
      15,
    );
    // 100 - 12 - 6 - 10 (errors) - 4 (apdex)
    expect(h.score).toBe(68);
    expect(h.level).toBe("critical");
    expect(
      healthOf([], [], totals({ errorRate: 0.5, apdex: null }), 15).score,
    ).toBe(70);
    expect(
      healthOf(
        Array.from({ length: 6 }, (_, i) => item("high", `h${i}`)),
        [],
        totals({ apdex: 0 }),
        15,
      ).score,
    ).toBe(0);
  });

  it("maps the score to a level at 90 and 70", () => {
    const at = (penaltyApdex: number) =>
      healthOf([], [], totals({ apdex: penaltyApdex }), 15);
    // (1 - apdex) * 40 = 10 -> 90, 11 -> 89, 30 -> 70, 31 -> 69
    expect(at(0.75).level).toBe("healthy");
    expect(at(0.725).level).toBe("degraded");
    expect(at(0.25).level).toBe("degraded");
    expect(at(0.225).level).toBe("critical");
  });

  it("words the summary for one, two and many things, better items and no traffic", () => {
    expect(healthOf([item("high", "A")], [], totals(), 15).summary).toBe(
      "1 thing needs attention: A.",
    );
    expect(
      healthOf([item("high", "A"), item("medium", "B")], [], totals(), 15)
        .summary,
    ).toBe("2 things need attention: A, and B.");
    expect(
      healthOf(
        [item("high", "A"), item("medium", "B"), item("medium", "C")],
        [],
        totals(),
        15,
      ).summary,
    ).toBe("3 things need attention: A, and B.");
    const better: Insight = { ...item("low", "X"), direction: "better" };
    expect(healthOf([], [better], totals(), 15).summary).toBe(
      "No problems found. 1 thing got better.",
    );
    expect(healthOf([], [better, better, better], totals(), 15).summary).toBe(
      "No problems found. 3 things got better.",
    );
    expect(
      healthOf([], [], totals({ count: 0, apdex: null }), 60).summary,
    ).toBe("No requests in the last 60 minutes.");
  });
});

describe("formatting", () => {
  it("shows milliseconds below a second and seconds with one decimal after", () => {
    expect(formatMs(412)).toBe("412 ms");
    expect(formatMs(999.4)).toBe("999 ms");
    expect(formatMs(1000)).toBe("1.0 s");
    expect(formatMs(1140)).toBe("1.1 s");
  });
});
