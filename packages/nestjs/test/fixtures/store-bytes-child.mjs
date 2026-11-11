// Child process for store-bytes.test.ts, run with --expose-gc. Feeds realistic spans
// through a real SDK 3 provider into the store and prints the store's byte estimate next
// to the heap growth it caused (heapUsed after a forced GC, before and after).
// argv[2]: number of traces (default 2000); argv[3]: "two-byte" to use non-Latin-1 values,
// "two-byte-large" for the same with about 8 KB per value;
// argv[4]: "evict" to keep only 300 traces, each with an error item, so most are evicted
// (the heap growth then shows whether evicted traces are really released).
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { TracerProvider } from "@opentelemetry/sdk-trace";

const { createStoreProcessor } = await import("../../src/store/processor.ts");
const { getOrCreateStore, resetStoreForTests } = await import(
  "../../src/store/store.ts"
);

const traces = Number(process.argv[2] ?? 2000);
const large = process.argv[3] === "two-byte-large";
const wide = process.argv[3] === "two-byte" || large;
// About 8 KB as two-byte characters (4,096 chars), so the per-character cost dominates.
const padding = large ? "日本語".repeat(1366) : "";
const evict = process.argv[4] === "evict";
const quiet = { logOnce() {}, countFailure() {} };
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

// A fresh store with a provider feeding it. Called twice: once for the warm-up, once for
// the measurement, so the measured store starts empty and its provider is a new one.
function setup() {
  const store = getOrCreateStore(
    { maxTraces: evict ? 300 : 1e9, maxBytes: 1e12 },
    quiet,
  );
  store.attach({});
  const provider = new TracerProvider({
    spanProcessors: [createStoreProcessor(store)],
  });
  return { store, tracer: provider.getTracer("@nestrix/nestjs", "0.0.0") };
}
// A fresh heap string, as values parsed from a request (headers, URL) and computed span
// names are in a real app; literals would be shared and under-state the cost.
const fresh = (s) => [...s].join("");
const text = (s) => fresh(wide ? `${s}·ünïcødé·日本${padding}` : s);

function oneTrace(tracer, i) {
  const server = tracer.startSpan(fresh("GET /users/:id"), {
    kind: SpanKind.SERVER,
    attributes: {
      "http.request.method": "GET",
      "url.path": text(`/users/${i}`),
      "url.scheme": "http",
      "url.query": text(`page=${i % 7}&token=REDACTED`),
      "http.route": "/users/:id",
      "http.response.status_code": i % 13 === 0 ? 500 : 200,
      "server.address": fresh("localhost"),
      "server.port": 3000,
      "client.address": fresh("127.0.0.1"),
      "network.protocol.version": "1.1",
      "user_agent.original": fresh(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      ),
      "http.request.header.content-type": ["application/json"],
      "nestjs.controller": "UsersController",
      "nestjs.handler": "findOne",
    },
  });
  const ctx = trace.setSpan(context.active(), server);
  const handler = tracer.startSpan(
    "UsersController.findOne",
    {
      attributes: { "nestjs.type": "handler", "code.function.name": "findOne" },
    },
    ctx,
  );
  const db = tracer.startSpan(
    "SELECT users",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "db.system.name": "postgresql",
        "db.namespace": "app",
        "db.operation.name": "SELECT",
        "db.query.text": text(
          `SELECT id, name, email, created_at FROM users WHERE id = $1 AND tenant_id = $2 LIMIT 1 /* ${i} */`,
        ),
        "server.address": "db.internal",
        "server.port": 5432,
      },
    },
    trace.setSpan(ctx, handler),
  );
  db.end();
  const out = tracer.startSpan(
    "GET",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": "GET",
        "url.full": text(`https://api.example.com/v1/profiles/${i}?expand=all`),
        "server.address": fresh("api.example.com"),
        "server.port": 443,
        "http.response.status_code": 200,
      },
    },
    trace.setSpan(ctx, handler),
  );
  out.end();
  if (evict || i % 13 === 0) {
    handler.recordException(new Error(text(`user ${i} lookup failed`)));
    handler.setStatus({ code: SpanStatusCode.ERROR, message: "lookup failed" });
  }
  handler.end();
  server.end();
}

// Warm up on a throwaway store, long enough for V8 to finish lazy compilation, tiering and
// feedback allocation, which differ by V8 version (on Node 22 they added about 300 KB of
// code and bytecode to the heap during a short measured run, and that dwarfed the 400 KB
// the evict case retains). Then drop the store, and measure a new one from empty.
{
  const warm = setup();
  for (let i = 0; i < (large ? 300 : 3000); i++) {
    oneTrace(warm.tracer, -i - 1);
    if (i % 500 === 0) warm.store.drainNow();
  }
  warm.store.drainNow();
  resetStoreForTests();
}
const { store, tracer } = setup();
globalThis.gc();
globalThis.gc();
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < traces; i++) {
  oneTrace(tracer, i);
  if (i % 500 === 0) store.drainNow();
}
store.drainNow();
globalThis.gc();
globalThis.gc();
const after = process.memoryUsage().heapUsed;
const stats = store.stats();
const json = JSON.stringify(
  Array.from({ length: Math.min(traces, 200) }, (_, k) =>
    store.getTrace(store.listTraces({ limit: 200 }).items[k]?.traceId ?? ""),
  ),
).length;
process.stdout.write(
  JSON.stringify({
    traces: stats.traces,
    evictedTraces: stats.evictedTraces,
    errorItems: stats.errorItems,
    spans: stats.spans,
    estimatedBytes: stats.bytes,
    heapBytes: after - before,
    ratio: stats.bytes / (after - before),
    jsonBytesPer200Traces: json,
  }),
);
