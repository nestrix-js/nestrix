// Fixtures of `GET api/v1/routes/explain` (packages/protocol/src/route-explain.ts) for the route
// detail e2e tests (P12-02): a route that got slower because of an N+1, the same route compared
// release against release, one with too few traces, and one without any. Hand-built, so a test
// can say exactly what it expects on screen.

import type {
  ExplainKindRow,
  ExplainSideInfo,
  RouteExplainResponse,
} from "@nestrix-js/protocol";

const MIN = 60_000;
export const ORDERS_STATEMENT = "SELECT * FROM order_items WHERE order_id = $1";
export const RELEASES = ["v1.8.2", "v1.8.1", "v1.8.0"];

const side = (
  over: Partial<ExplainSideInfo> & Pick<ExplainSideInfo, "label">,
): ExplainSideInfo => ({
  fromUnixMs: 0,
  toUnixMs: 0,
  traces: 120,
  meanMs: 214,
  p95Ms: 412,
  errorRate: 0.009,
  ...over,
});

const kinds = (
  rows: [ExplainKindRow["key"], number, number][],
): ExplainKindRow[] =>
  rows.map(([key, beforeMs, afterMs]) => ({ key, beforeMs, afterMs }));

/** The N+1 story: database time 96 ms to 318 ms, one new statement, a new error, a faster cache. */
function base(
  q: URLSearchParams,
  now: number,
  mode: "window" | "release",
): RouteExplainResponse {
  const windowMinutes = Number(q.get("windowMinutes") ?? 60);
  const release = mode === "release";
  return {
    mode,
    method: q.get("method"),
    route: q.get("route") ?? "/orders",
    before: side({
      label: release ? (q.get("releaseA") ?? "v1.8.1") : "previous",
      fromUnixMs: now - 2 * windowMinutes * MIN,
      toUnixMs: now - windowMinutes * MIN,
    }),
    after: side({
      label: release ? (q.get("releaseB") ?? "v1.8.2") : "current",
      fromUnixMs: now - windowMinutes * MIN,
      toUnixMs: now,
      traces: 140,
      meanMs: 436,
      p95Ms: 680,
      errorRate: 0.028,
    }),
    releases: RELEASES,
    summary:
      "Mean time went from 214 ms to 436 ms; most of it is Database time (+222 ms), mainly one new statement.",
    findings: [
      {
        kind: "n-plus-one",
        direction: "worse",
        title: `A new statement runs 6.4 times per request (${ORDERS_STATEMENT}), adding 214 ms.`,
        deltaMs: 214,
        shareOfChange: 0.96,
        link: { view: "queries", params: { q: ORDERS_STATEMENT } },
      },
      {
        kind: "new-error",
        direction: "worse",
        title: "PaymentGatewayError is new: 14 traces.",
        deltaMs: null,
        shareOfChange: null,
        link: {
          view: "errors",
          params: { route: "/orders", type: "PaymentGatewayError" },
        },
      },
      {
        kind: "faster",
        direction: "better",
        title: "redis cache takes 6.0 ms per request, was 24 ms.",
        deltaMs: -18,
        shareOfChange: null,
        link: { view: "dependencies", params: { name: "redis cache" } },
      },
    ],
    kinds: kinds([
      ["db", 96, 318],
      ["app", 72, 74],
      ["http-out", 40, 38],
      ["redis", 6, 6],
    ]),
    statements: [
      {
        statement: ORDERS_STATEMENT,
        system: "postgresql",
        beforeCalls: 0,
        afterCalls: 6.4,
        beforeMs: 0,
        afterMs: 214,
        beforeEachMs: null,
        afterEachMs: 33.4,
      },
      {
        statement: "SELECT * FROM orders WHERE id = $1",
        system: "postgresql",
        beforeCalls: 1,
        afterCalls: 1,
        beforeMs: 48,
        afterMs: 52,
        beforeEachMs: 48,
        afterEachMs: 52,
      },
      {
        statement: "INSERT INTO orders (customer_id, total) VALUES ($1, $2)",
        system: "postgresql",
        beforeCalls: 1,
        afterCalls: 1,
        beforeMs: 31,
        afterMs: 32,
        beforeEachMs: 31,
        afterEachMs: 32,
      },
      {
        statement: "SELECT * FROM users WHERE id = $1",
        system: "postgresql",
        beforeCalls: 1,
        afterCalls: 1,
        beforeMs: 17,
        afterMs: 20,
        beforeEachMs: 17,
        afterEachMs: 20,
      },
    ],
    methods: [
      {
        name: "OrderItemsRepository.findByOrder",
        beforeCalls: 0,
        afterCalls: 6.4,
        beforeMs: 0,
        afterMs: 241,
      },
      {
        name: "OrdersService.create",
        beforeCalls: 1,
        afterCalls: 1,
        beforeMs: 55,
        afterMs: 58,
      },
    ],
    dependencies: [
      {
        name: "api.stripe.com",
        kind: "http",
        beforeCalls: 1,
        afterCalls: 1,
        beforeMs: 40,
        afterMs: 38,
        beforeErrorRate: 0.01,
        afterErrorRate: 0.07,
      },
      {
        name: "redis cache",
        kind: "redis",
        beforeCalls: 2,
        afterCalls: 2,
        beforeMs: 24,
        afterMs: 6,
        beforeErrorRate: null,
        afterErrorRate: null,
      },
    ],
    errors: [
      {
        type: "PaymentGatewayError",
        message: "Gateway timed out after 3000 ms",
        beforeTraces: 0,
        afterTraces: 14,
      },
      {
        type: "ValidationError",
        message: "total must be positive",
        beforeTraces: 1,
        afterTraces: 2,
      },
    ],
    slowest: [
      ["a1", 4800, 500, true, [3900, 300, 560, 40]],
      ["a2", 3100, 201, false, [2400, 210, 470, 20]],
      ["a3", 2700, 201, false, [1800, 160, 700, 40]],
    ].map(([id, durationMs, status, error, ms]) => ({
      traceId: `${String(id).repeat(16)}${String(id).repeat(16)}`.slice(0, 32),
      startUnixMs: now - 3 * MIN,
      durationMs: durationMs as number,
      status: status as number,
      error: error as boolean,
      byKind: (ms as number[]).map((v, i) => ({
        key: (["db", "app", "http-out", "redis"] as const)[i] as "db",
        ms: v,
      })),
    })),
  };
}

/** The route got slower since the previous window (an N+1). */
export const slower = (q: URLSearchParams, now = Date.now()) =>
  base(q, now, "window");

/** The same story, release against release. */
export const releases = (q: URLSearchParams, now = Date.now()) =>
  base(q, now, "release");

/** Four traces on one side: the summary says so, no findings. */
export function fewTraces(
  q: URLSearchParams,
  now = Date.now(),
): RouteExplainResponse {
  const full = base(q, now, "window");
  return {
    ...full,
    before: { ...full.before, traces: 3 },
    findings: [],
    summary: "Not enough traces to compare (3 before, 140 after).",
  };
}

/** No trace on either side: the route is unknown, or has none kept. */
export function emptyExplain(q: URLSearchParams): RouteExplainResponse {
  const windowMinutes = Number(q.get("windowMinutes") ?? 60);
  const zero = (label: string): ExplainSideInfo =>
    side({
      label,
      fromUnixMs: 0,
      toUnixMs: windowMinutes * MIN,
      traces: 0,
      meanMs: 0,
      p95Ms: 0,
      errorRate: 0,
    });
  return {
    mode: q.has("releaseA") ? "release" : "window",
    method: q.get("method"),
    route: q.get("route") ?? "",
    before: zero("previous"),
    after: zero("current"),
    releases: [],
    findings: [],
    summary: "Not enough traces to compare (0 before, 0 after).",
    kinds: [],
    statements: [],
    methods: [],
    dependencies: [],
    errors: [],
    slowest: [],
  };
}
