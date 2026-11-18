// Fills a server with realistic traces and trace logs so the disk used per span and per log line
// can be read from the database (docs-site/guide/production.md, "Storage").
//
//   node apps/server/scripts/footprint-load.mjs
//
// Env: OTLP_URL (default http://127.0.0.1:4318), TRACES (default 20000), PER_REQUEST (traces per
// request, default 200), LOGS_PER_TRACE (default 2), KEY (an ingest key, optional).
// One trace is six spans (an HTTP server span, a guard, an interceptor, the handler, a service
// method and a database client span, 5 to 11 attributes each, the database one with a 70
// character statement) and LOGS_PER_TRACE log lines of about 90 characters, all sent as OTLP/JSON.
// Plain `fetch`, no dependencies. Prints one JSON object with what was sent and accepted.
import { randomBytes } from "node:crypto";

const url = process.env.OTLP_URL ?? "http://127.0.0.1:4318";
const traces = Number(process.env.TRACES ?? 20000);
const perRequest = Number(process.env.PER_REQUEST ?? 200);
const logsPerTrace = Number(process.env.LOGS_PER_TRACE ?? 2);
const headers = { "content-type": "application/json" };
if (process.env.KEY) headers.authorization = `Bearer ${process.env.KEY}`;

const hex = (n) => randomBytes(n).toString("hex");
const str = (key, value) => ({ key, value: { stringValue: value } });
const int = (key, value) => ({ key, value: { intValue: String(value) } });
const resource = {
  attributes: [
    str("service.name", "orders"),
    str("service.version", "1.4.2"),
    str("service.instance.id", "orders-7d9f6c5b8-x2k4p"),
    str("deployment.environment.name", "production"),
    str("telemetry.sdk.language", "nodejs"),
  ],
};

function span(traceId, parentSpanId, name, kind, startNs, durNs, attributes) {
  return {
    traceId,
    spanId: hex(8),
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    kind,
    startTimeUnixNano: String(startNs),
    endTimeUnixNano: String(startNs + durNs),
    attributes,
    status: { code: 0 },
  };
}

function oneTrace(startNs, i) {
  const traceId = hex(16);
  const ms = 1_000_000n;
  const root = span(traceId, null, "GET /orders/:id", 2, startNs, 12n * ms, [
    str("http.request.method", "GET"),
    str("http.route", "/orders/:id"),
    str("url.path", `/orders/${1000 + (i % 5000)}`),
    str("url.scheme", "http"),
    int("http.response.status_code", 200),
    str("server.address", "orders.internal"),
    str("client.address", "10.4.17.22"),
    str("network.protocol.version", "1.1"),
    str(
      "user_agent.original",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0",
    ),
    str("nestrix.entry", "http"),
  ]);
  const guard = span(
    traceId,
    root.spanId,
    "AuthGuard.canActivate",
    1,
    startNs + 1n * ms,
    1n * ms,
    [
      str("nestrix.class", "AuthGuard"),
      str("nestrix.method", "canActivate"),
      str("nestrix.kind", "guard"),
    ],
  );
  const interceptor = span(
    traceId,
    root.spanId,
    "LoggingInterceptor.intercept",
    1,
    startNs + 2n * ms,
    9n * ms,
    [
      str("nestrix.class", "LoggingInterceptor"),
      str("nestrix.method", "intercept"),
      str("nestrix.kind", "interceptor"),
    ],
  );
  const handler = span(
    traceId,
    interceptor.spanId,
    "OrdersController.findOne",
    1,
    startNs + 3n * ms,
    7n * ms,
    [
      str("nestrix.class", "OrdersController"),
      str("nestrix.method", "findOne"),
      str("nestrix.kind", "handler"),
      str("http.route", "/orders/:id"),
    ],
  );
  const service = span(
    traceId,
    handler.spanId,
    "OrdersService.findOne",
    1,
    startNs + 4n * ms,
    5n * ms,
    [
      str("nestrix.class", "OrdersService"),
      str("nestrix.method", "findOne"),
      str("nestrix.kind", "provider"),
    ],
  );
  const db = span(
    traceId,
    service.spanId,
    "SELECT orders",
    3,
    startNs + 5n * ms,
    3n * ms,
    [
      str("db.system.name", "postgresql"),
      str("db.namespace", "orders"),
      str("db.operation.name", "SELECT"),
      str(
        "db.query.text",
        "SELECT id, customer_id, total, status FROM orders WHERE id = $1",
      ),
      str("server.address", "db.internal"),
      int("server.port", 5432),
    ],
  );
  const spans = [root, guard, interceptor, handler, service, db];
  const logs = [];
  for (let l = 0; l < logsPerTrace; l++) {
    logs.push({
      timeUnixNano: String(startNs + BigInt(l + 1) * ms),
      severityNumber: 9,
      severityText: "INFO",
      body: {
        stringValue: `Order ${1000 + (i % 5000)} loaded for customer ${hex(4)} in 3 ms`,
      },
      attributes: [str("nestrix.log.context", "OrdersService")],
      traceId,
      spanId: service.spanId,
    });
  }
  return { spans, logs };
}

async function post(path, body) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let rejected = 0;
  try {
    rejected = Number(
      JSON.parse(text).partialSuccess?.rejectedSpans ??
        JSON.parse(text).partialSuccess?.rejectedLogRecords ??
        0,
    );
  } catch {}
  return { status: response.status, rejected };
}

const started = Date.now();
let sentSpans = 0;
let sentLogs = 0;
let failed = 0;
let rejected = 0;
const base = BigInt(Date.now() - 60_000) * 1_000_000n;
for (let done = 0; done < traces; done += perRequest) {
  const spans = [];
  const logs = [];
  for (let i = done; i < Math.min(traces, done + perRequest); i++) {
    const t = oneTrace(base + BigInt(i) * 2_000_000n, i);
    spans.push(...t.spans);
    logs.push(...t.logs);
  }
  const s = await post("/v1/traces", {
    resourceSpans: [
      { resource, scopeSpans: [{ scope: { name: "footprint" }, spans }] },
    ],
  });
  if (s.status === 200) sentSpans += spans.length;
  else failed++;
  rejected += s.rejected;
  if (logsPerTrace > 0) {
    const l = await post("/v1/logs", {
      resourceLogs: [
        {
          resource,
          scopeLogs: [{ scope: { name: "footprint" }, logRecords: logs }],
        },
      ],
    });
    if (l.status === 200) sentLogs += logs.length;
    else failed++;
    rejected += l.rejected;
  }
}
console.log(
  JSON.stringify(
    {
      seconds: (Date.now() - started) / 1000,
      traces,
      spansAccepted: sentSpans,
      logsAccepted: sentLogs,
      failedRequests: failed,
      rejectedRecords: rejected,
    },
    null,
    2,
  ),
);
