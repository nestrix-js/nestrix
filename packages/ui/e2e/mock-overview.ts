// Fixtures of `GET api/v1/overview` (packages/protocol/src/overview.ts) for the Overview e2e
// tests: a degraded app, a healthy one, one with no traffic, and one whose previous window is
// not kept. Hand-built, so a test can say exactly what it expects on screen.

import type {
  Insight,
  OverviewResponse,
  OverviewSeriesPoint,
  OverviewTotals,
  RouteCompareResponse,
  RouteStatsResponse,
} from "@nestrix-js/protocol";

const MIN = 60_000;

const totals = (over: Partial<OverviewTotals>): OverviewTotals => ({
  count: 19_260,
  errors: 366,
  errorRate: 0.019,
  p50Ms: 84,
  p95Ms: 412,
  p99Ms: 1300,
  perMinute: 1284,
  apdex: 0.91,
  satisfied: 16_564,
  tolerating: 1_926,
  frustrated: 770,
  ...over,
});

function points(
  from: number,
  n: number,
  bucketMs: number,
  shape: (i: number) => { count: number; errors: number; p95: number },
): OverviewSeriesPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const s = shape(i);
    return {
      timeUnixMs: from + i * bucketMs,
      count: s.count,
      errors: s.errors,
      p50Ms: s.p95 / 4,
      p95Ms: s.p95,
      p99Ms: s.p95 * 3,
    };
  });
}

const sparkSeries = (rise: number) =>
  Array.from({ length: 15 }, (_, i) => 1 + (i >= 8 ? rise : 0) + (i % 3) * 0.2);

const insight = (
  over: Partial<Insight> & Pick<Insight, "id" | "title">,
): Insight => ({
  kind: "route-latency",
  direction: "worse",
  severity: "high",
  detail: "1,920 requests in the window",
  before: 412,
  after: 680,
  unit: "ms",
  change: 0.65,
  impact: 1248,
  series: sparkSeries(2),
  source: "stats",
  link: { view: "route", params: { method: "POST", route: "/orders" } },
  ...over,
});

/** Two things need attention (one from each source) and one thing got better. */
export function degraded(
  windowMinutes = 15,
  now = Date.now(),
): OverviewResponse {
  const bucketMs = windowMinutes <= 15 ? MIN : 5 * MIN;
  const n = (windowMinutes * MIN) / bucketMs;
  const from = now - windowMinutes * MIN;
  return {
    windowMinutes,
    bucketMs,
    current: { fromUnixMs: from, toUnixMs: now },
    previous: { fromUnixMs: from - windowMinutes * MIN, toUnixMs: from },
    previousCovered: true,
    note: null,
    apdexMs: 300,
    health: {
      score: 74,
      level: "degraded",
      summary:
        "2 things need attention: POST /orders p95 412 ms → 680 ms, and PaymentGatewayError is new (214 events).",
    },
    totals: totals({}),
    previousTotals: totals({
      count: 18_000,
      errors: 130,
      errorRate: 0.0072,
      p95Ms: 350,
      perMinute: 1200,
      apdex: 0.94,
    }),
    series: points(from, n, bucketMs, (i) => ({
      count: 1200 + i * 5,
      errors: i > n - 5 ? 40 : 3,
      p95: i > n - 6 ? 600 : 330,
    })),
    previousSeries: points(from - windowMinutes * MIN, n, bucketMs, () => ({
      count: 1150,
      errors: 3,
      p95: 340,
    })),
    releases: [
      { version: "v1.8.2", firstSeenUnixMs: from + (windowMinutes * MIN) / 2 },
    ],
    status: { ok: 940, redirect: 9, clientError: 8, serverError: 43 },
    timeByKind: [
      { key: "db", ms: 41_000, share: 0.41, previousShare: 0.29 },
      { key: "app", ms: 31_000, share: 0.31, previousShare: 0.35 },
      { key: "http-out", ms: 19_000, share: 0.19, previousShare: 0.16 },
      { key: "redis", ms: 6_000, share: 0.06, previousShare: 0.15 },
      { key: "other", ms: 3_000, share: 0.03, previousShare: 0.03 },
      { key: "messaging", ms: 0, share: 0, previousShare: null },
    ],
    attention: [
      insight({
        id: "route-latency:POST /orders",
        title: "POST /orders p95 412 ms → 680 ms",
        detail: "1,920 requests in the window · first seen in v1.8.2",
      }),
      insight({
        id: "error-group-new:PaymentGatewayError",
        kind: "error-group-new",
        severity: "high",
        title: "PaymentGatewayError is new (214 events)",
        detail: "3 routes · first seen 10:44",
        before: null,
        after: 214,
        unit: "count",
        change: null,
        impact: 214,
        source: "traces",
        link: { view: "errors", params: { search: "PaymentGatewayError" } },
      }),
      insight({
        id: "dependency-latency:api.stripe.com",
        kind: "dependency-latency",
        severity: "medium",
        title: "api.stripe.com p95 640 ms → 1.1 s",
        detail: "Outgoing HTTP · 480 calls",
        before: 640,
        after: 1100,
        unit: "ms",
        change: 0.72,
        impact: 345,
        source: "traces",
        link: { view: "dependencies", params: {} },
      }),
    ],
    better: [
      insight({
        id: "route-latency:GET /products/:id",
        direction: "better",
        severity: "low",
        title: "GET /products/:id p95 133 ms → 96 ms",
        detail: "4,100 requests in the window",
        before: 133,
        after: 96,
        change: -0.28,
        impact: 1148,
        series: sparkSeries(-0.5).map((v) => Math.max(0.2, v)),
        link: {
          view: "route",
          params: { method: "GET", route: "/products/:id" },
        },
      }),
    ],
  };
}

/** Nothing needs attention; two things got better. */
export function healthy(
  windowMinutes = 15,
  now = Date.now(),
): OverviewResponse {
  const base = degraded(windowMinutes, now);
  return {
    ...base,
    health: {
      score: 97,
      level: "healthy",
      summary: "No problems found. 2 things got better.",
    },
    totals: totals({
      errors: 12,
      errorRate: 0.0006,
      p95Ms: 120,
      p99Ms: 300,
      apdex: 0.99,
      satisfied: 19_000,
      tolerating: 240,
      frustrated: 20,
    }),
    previousTotals: totals({ errorRate: 0.004, p95Ms: 160, apdex: 0.96 }),
    status: { ok: 980, redirect: 10, clientError: 10, serverError: 0 },
    releases: [],
    attention: [],
    better: [
      ...base.better,
      insight({
        id: "error-group-cleared:RedisError",
        kind: "error-group-new",
        direction: "better",
        severity: "low",
        title: "RedisError cleared",
        detail: "0 in the last 7 minutes, 61 before",
        before: 61,
        after: 0,
        unit: "count",
        change: -1,
        impact: 61,
        source: "traces",
        link: { view: "errors", params: {} },
      }),
    ],
  };
}

/** No requests in either window. */
export function empty(windowMinutes = 15, now = Date.now()): OverviewResponse {
  const base = degraded(windowMinutes, now);
  const zero = totals({
    count: 0,
    errors: 0,
    errorRate: 0,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    perMinute: 0,
    apdex: null,
    satisfied: 0,
    tolerating: 0,
    frustrated: 0,
  });
  return {
    ...base,
    health: {
      score: 100,
      level: "healthy",
      summary: `No requests in the last ${windowMinutes} minutes.`,
    },
    totals: zero,
    previousTotals: zero,
    series: [],
    previousSeries: [],
    releases: [],
    status: { ok: 0, redirect: 0, clientError: 0, serverError: 0 },
    timeByKind: [],
    attention: [],
    better: [],
  };
}

export const UNCOVERED_NOTE =
  "Statistics are kept for 20 minutes, less than the 30 this comparison needs.";

/** Traffic, but the previous window is not kept: no comparison, only what is new. */
export function uncovered(
  windowMinutes = 15,
  now = Date.now(),
): OverviewResponse {
  const base = degraded(windowMinutes, now);
  return {
    ...base,
    previousCovered: false,
    note: UNCOVERED_NOTE,
    previousTotals: null,
    previousSeries: [],
    health: {
      score: 88,
      level: "degraded",
      summary:
        "1 thing needs attention: PaymentGatewayError is new (214 events).",
    },
    timeByKind: base.timeByKind.map((t) => ({ ...t, previousShare: null })),
    attention: base.attention.filter((i) => i.before === null),
    better: [],
  };
}

/** `routes` and `routes/compare` answers that agree with `degraded`, for the Routes card. */
export function routeAnswers(now = Date.now()): {
  stats: (windowMinutes: number) => RouteStatsResponse;
  compare: (windowMinutes: number) => RouteCompareResponse;
} {
  const rows = [
    ["POST", "/orders", 1920, 412, 680, 54],
    ["GET", "/products/:id", 4100, 133, 96, 0],
    ["GET", "/search", 3100, 510, 540, 12],
  ] as const;
  return {
    stats: (windowMinutes) => ({
      windowMinutes,
      bucketMs: MIN,
      fromUnixMs: now - windowMinutes * MIN,
      toUnixMs: now,
      routes: rows.map(([method, route, count, , p95, errors]) => ({
        method,
        route,
        count,
        errors,
        p50Ms: p95 / 4,
        p95Ms: p95,
        p99Ms: p95 * 2,
        maxMs: p95 * 4,
        series: points(now - 15 * MIN, 15, MIN, (i) => ({
          count: count / 15,
          errors: errors / 15,
          p95: p95 * (0.8 + (i % 4) * 0.1),
        })),
      })),
    }),
    compare: (windowMinutes) => ({
      mode: "window",
      windowMinutes,
      previous: {
        fromUnixMs: now - 2 * windowMinutes * MIN,
        toUnixMs: now - windowMinutes * MIN,
      },
      current: { fromUnixMs: now - windowMinutes * MIN, toUnixMs: now },
      previousCovered: true,
      note: null,
      releases: ["v1.8.2", "v1.8.1"],
      routes: rows.map(([method, route, count, before, after, errors]) => ({
        method,
        route,
        before: { count, errors: 3, p50Ms: before / 4, p95Ms: before },
        after: { count, errors, p50Ms: after / 4, p95Ms: after },
        delta: {
          count: 0,
          errorRate: (errors - 3) / count,
          p50Ms: (after - before) / 4,
          p95Ms: after - before,
        },
      })),
    }),
  };
}
