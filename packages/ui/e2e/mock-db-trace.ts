// Traces for the query-insight and span-link tests: database spans (slow and repeated) and links.
import type { SpanRecord, TraceResponse } from "@nestrix/protocol";

export const DB_TRACE_ID = "d1".repeat(16);
export const LINKED_TRACE_ID = "d2".repeat(16);
export const MISSING_TRACE_ID = "d3".repeat(16);
export const REPEATED_SQL = "SELECT * FROM users WHERE id = $1";
export const OTHER_SQL = "SELECT * FROM orders";

const T0 = 1_794_400_000_000;
const id = (n: number) => n.toString(16).padStart(16, "0");

function span(
  n: number,
  parent: number | undefined,
  name: string,
  offset: number,
  durationMs: number,
  attributes: SpanRecord["attributes"] = {},
  links: SpanRecord["links"] = [],
): SpanRecord {
  return {
    spanId: id(n),
    parentSpanId: parent === undefined ? undefined : id(parent),
    name,
    kind: parent === undefined ? "server" : "client",
    startTimeUnixMs: T0 + offset,
    durationMs,
    attributes,
    events: [],
    status: { code: "unset" },
    links,
  };
}

/** Span ids, by what they are. */
export const DB_SPANS = {
  repeated: [id(3), id(4), id(5)],
  slow: id(6),
  fastLegacy: id(7),
  slowNotDb: id(8),
  linked: id(2),
};

/**
 * Root (1), a handler (2) that carries two links, three identical fast queries (3 to 5), one
 * slow query using the legacy `db.system` attribute (6), a fast legacy one (7), and a slow
 * span that is not a database span (8).
 */
export const dbTrace: TraceResponse = {
  traceId: DB_TRACE_ID,
  rootSpanId: id(1),
  resource: { "service.name": "demo-service" },
  spans: [
    span(1, undefined, "GET /orders", 0, 400, {
      "http.request.method": "GET",
      "http.route": "/orders",
      "http.response.status_code": 200,
    }),
    span(2, 1, "OrdersController.list", 1, 390, {}, [
      { traceId: LINKED_TRACE_ID, spanId: id(1) },
      { traceId: MISSING_TRACE_ID, spanId: id(1) },
    ]),
    ...[3, 4, 5].map((n) =>
      span(n, 2, "SELECT users", 5 + (n - 3) * 12, 10, {
        "db.system.name": "postgresql",
        "db.query.text": REPEATED_SQL,
      }),
    ),
    span(6, 2, "SELECT orders", 50, 150, {
      "db.system": "postgresql",
      "db.query.text": OTHER_SQL,
    }),
    span(7, 2, "SELECT orders", 210, 99.5, {
      "db.system.name": "postgresql",
      "db.query.text": OTHER_SQL,
    }),
    span(8, 2, "render", 320, 60, { "app.work": "render" }),
  ],
};

/** A job trace the link of `dbTrace` points to. */
export const linkedTrace: TraceResponse = {
  traceId: LINKED_TRACE_ID,
  rootSpanId: id(1),
  resource: { "service.name": "demo-service" },
  spans: [
    {
      ...span(1, undefined, "orders process", 0, 20, {
        "nestrix.entry": "job",
      }),
      kind: "consumer",
    },
  ],
};
