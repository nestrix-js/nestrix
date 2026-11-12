// Fixture data for the unit and standalone-server tests (shapes of @nestrix-js/protocol).
import type {
  AppMapResponse,
  ClassStatsResponse,
  ErrorListResponse,
  MetaResponse,
  RouteStatsResponse,
  SpanRecord,
  TraceListResponse,
  TraceResponse,
} from "@nestrix-js/protocol";

export const T0 = 1_794_400_000_000;
export const id = (n: number): string => n.toString(16).padStart(16, "0");
export const traceId = (n: number): string => n.toString(16).padStart(32, "0");

export const REPEATED_SQL = "SELECT * FROM users WHERE id = $1";

/** A span builder: `offset` and `durationMs` in ms from the trace start. */
export function span(
  n: number,
  parent: number | undefined,
  name: string,
  offset: number,
  durationMs: number,
  attributes: SpanRecord["attributes"] = {},
  extra: Partial<SpanRecord> = {},
): SpanRecord {
  return {
    spanId: id(n),
    ...(parent === undefined ? {} : { parentSpanId: id(parent) }),
    name,
    kind: parent === undefined ? "server" : "internal",
    startTimeUnixMs: T0 + offset,
    durationMs,
    attributes,
    events: [],
    status: { code: "unset" },
    links: [],
    ...extra,
  };
}

/** GET /orders: a handler that runs the same query five times (N+1) and one slow, different query. */
export const nPlusOneTrace: TraceResponse = {
  traceId: traceId(1),
  rootSpanId: id(1),
  resource: { "service.name": "orders-api", "service.version": "1.4.2" },
  spans: [
    span(1, undefined, "GET /orders", 0, 300, {
      "http.request.method": "GET",
      "http.route": "/orders",
      "http.response.status_code": 200,
      "http.request.header.cookie": "noise",
      "process.pid": 1,
    }),
    span(2, 1, "OrdersController.list", 2, 290, {
      "code.function.name": "OrdersController.list",
      "nestrix.kind": "controller",
    }),
    ...[3, 4, 5, 6, 7].map((n) =>
      span(
        n,
        2,
        "SELECT users",
        5 + (n - 3) * 12,
        10,
        { "db.system.name": "postgresql", "db.query.text": REPEATED_SQL },
        { kind: "client" },
      ),
    ),
    span(
      8,
      2,
      "SELECT orders",
      80,
      180,
      {
        "db.system.name": "postgresql",
        "db.query.text": "SELECT *\n  FROM orders\n WHERE open",
      },
      { kind: "client" },
    ),
    // Two queries that differ: below the repeat threshold of three.
    ...[9, 10].map((n) =>
      span(
        n,
        2,
        "SELECT items",
        265,
        5,
        {
          "db.system.name": "postgresql",
          "db.query.text": "SELECT * FROM items",
        },
        { kind: "client" },
      ),
    ),
  ],
};

export const STACK = [
  "BadGatewayException: Payments service unavailable",
  "    at OrdersService.load (/app/orders.service.ts:31:11)",
  "    at OrdersController.get (/app/orders.controller.ts:12:5)",
  "    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)",
  "    at next (/app/node_modules/express/lib/router/route.js:149:13)",
].join("\n");

/** GET /orders/:id fails with an exception whose stack has four frames. */
export const errorTrace: TraceResponse = {
  traceId: traceId(2),
  rootSpanId: id(1),
  resource: { "service.name": "orders-api" },
  spans: [
    span(
      1,
      undefined,
      "GET /orders/:id",
      0,
      40,
      {
        "http.request.method": "GET",
        "http.route": "/orders/:id",
        "http.response.status_code": 502,
      },
      { status: { code: "error", message: "Payments service unavailable" } },
    ),
    span(
      2,
      1,
      "OrdersService.load",
      1,
      35,
      {},
      {
        status: { code: "error", message: "Payments service unavailable" },
        events: [
          {
            name: "exception",
            timeUnixMs: T0 + 30,
            attributes: {
              "exception.type": "BadGatewayException",
              "exception.message": "Payments service unavailable",
              "exception.stacktrace": STACK,
            },
          },
        ],
      },
    ),
  ],
};

/** A root and one parent with `children` identical fast children, plus one slow and one failing child. */
export function wideTrace(children: number): TraceResponse {
  const spans = [
    span(1, undefined, "GET /wide", 0, 1000, { "http.route": "/wide" }),
    span(2, 1, "Handler.run", 1, 990),
  ];
  for (let i = 0; i < children; i++) {
    spans.push(span(100 + i, 2, "tick", 2 + i * 0.01, 0.5 + (i % 7) * 0.01));
  }
  spans.push(span(50, 2, "slow-step", 500, 400));
  spans.push(
    span(
      51,
      2,
      "failing-step",
      910,
      5,
      {},
      {
        status: { code: "error", message: "step failed" },
      },
    ),
  );
  return { traceId: traceId(3), rootSpanId: id(1), resource: {}, spans };
}

export const meta = (overrides: Partial<MetaResponse> = {}): MetaResponse => ({
  protocolVersion: 1,
  processId: "p-test",
  serverTimeUnixMs: T0 + 10_000,
  service: { name: "orders-api", version: "1.4.2", environment: "test" },
  sampling: { owner: "nestrix", rate: 0.25 },
  store: {
    traces: 3,
    spans: 20,
    bytes: 1000,
    maxTraces: 1000,
    maxBytes: 33_554_432,
    evictedTraces: 0,
    droppedSpans: 0,
  },
  statistics: { sinceUnixMs: T0 - 1000, windowMinutesOptions: [15, 60] },
  warnings: [],
  mode: "embedded",
  profiler: { available: true, running: false },
  ...overrides,
});

export const traceList: TraceListResponse = {
  head: "c1",
  older: null,
  reset: false,
  items: [nPlusOneTrace, errorTrace].map((t, i) => ({
    traceId: t.traceId,
    rootSpanId: id(1),
    name: i === 0 ? "GET /orders" : "GET /orders/:id",
    method: "GET",
    route: i === 0 ? "/orders" : "/orders/:id",
    statusCode: i === 0 ? 200 : 502,
    error: i === 1,
    startTimeUnixMs: T0 + i * 1000,
    durationMs: i === 0 ? 300 : 40,
    spanCount: t.spans.length,
    type: "http" as const,
    hasJob: false,
    cursor: `c${i}`,
  })),
};

export const errorList: ErrorListResponse = {
  head: "e1",
  older: null,
  reset: false,
  items: [1, 2, 3].map((n) => ({
    traceId: traceId(2),
    spanId: id(2),
    spanName: "OrdersService.load",
    spanKind: "internal" as const,
    route: "/orders/:id",
    method: "GET",
    statusCode: 502,
    errorType: "BadGatewayException",
    message: "Payments service unavailable",
    timeUnixMs: T0 + n * 1000,
    cursor: `e${n}`,
  })),
};

export const routes: RouteStatsResponse = {
  windowMinutes: 15,
  bucketMs: 60_000,
  fromUnixMs: T0 - 900_000,
  toUnixMs: T0,
  routes: [
    {
      method: "GET",
      route: "/orders",
      count: 120,
      errors: 0,
      p50Ms: 250,
      p95Ms: 310,
      p99Ms: 400,
      maxMs: 450,
      series: [],
    },
    {
      method: "GET",
      route: "/orders/:id",
      count: 40,
      errors: 8,
      p50Ms: 30,
      p95Ms: 60,
      p99Ms: 90,
      maxMs: 120,
      series: [],
    },
  ],
};

export const classes: ClassStatsResponse = {
  windowMinutes: 15,
  fromUnixMs: T0 - 900_000,
  toUnixMs: T0,
  methodsState: "on",
  methodsEnabled: true,
  classes: [
    {
      className: "OrdersController",
      kind: "controller",
      calls: 160,
      errors: 8,
      totalMs: 40_000,
      avgMs: 250,
      ownMs: 1200,
      methods: [
        {
          method: "list",
          calls: 120,
          errors: 0,
          totalMs: 36_000,
          avgMs: 300,
          maxMs: 450,
          ownAvgMs: 8,
        },
      ],
    },
  ],
};

export const map: AppMapResponse = {
  windowMinutes: 15,
  fromUnixMs: T0 - 900_000,
  toUnixMs: T0,
  nodes: [
    { id: "app", kind: "app", name: "orders-api" },
    {
      id: "db:pg",
      kind: "database",
      name: "postgresql shop",
      system: "postgresql",
    },
  ],
  edges: [
    { from: "app", to: "db:pg", calls: 700, errors: 2, p50Ms: 9, p95Ms: 180 },
  ],
};
