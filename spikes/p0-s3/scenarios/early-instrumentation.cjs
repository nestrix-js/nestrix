// Review fix 5: the early-tracer problem reaches level-4 upstream instrumentations.
// InstrumentationBase takes its tracer in its constructor
// (@opentelemetry/instrumentation dist/instrumentation.mjs: `this._tracer =
// trace.getTracer(...)`). A CommonJS host constructs one (from the .cjs copy), then
// Nestrix registers its provider through the .mjs copy. S3_CASE:
//   before   the host constructs UndiciInstrumentation before Nestrix registers
//   after    the host constructs it after Nestrix registers (control)
// A fetch inside a Nestrix (ESM) span then goes to a local server.
const http = require("node:http");

const which = process.env.S3_CASE ?? "before";
const {
  UndiciInstrumentation,
} = require("@opentelemetry/instrumentation-undici");
let instrumentation;
if (which === "before") instrumentation = new UndiciInstrumentation();

(async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.traceparent ?? null);
    res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  // Nestrix's setup, through the ESM copies.
  const api = await import("@opentelemetry/api");
  const sdk = await import("@opentelemetry/sdk-trace");
  const { AsyncLocalStorageContextManager } = await import(
    "@opentelemetry/context-async-hooks"
  );
  const { W3CTraceContextPropagator } = await import("@opentelemetry/core");
  const exporter = new sdk.InMemorySpanExporter();
  api.trace.setGlobalTracerProvider(
    new sdk.TracerProvider({
      spanProcessors: [new sdk.SimpleSpanProcessor({ exporter })],
    }),
  );
  api.context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  api.propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  if (which === "after") instrumentation = new UndiciInstrumentation();

  let parentSpanId;
  await api.trace
    .getTracer("nestrix-standin")
    .startActiveSpan("server", async (span) => {
      parentSpanId = span.spanContext().spanId;
      const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
      await res.arrayBuffer();
      span.end();
    });

  const spans = exporter.getFinishedSpans();
  const client = spans.find((s) => s.kind === api.SpanKind.CLIENT);
  process.stdout.write(
    `RESULT ${JSON.stringify({
      case: which,
      node: process.version,
      instrumentationEnabled: instrumentation.isEnabled?.() ?? null,
      exported: spans.map((s) => `${s.name}[${s.instrumentationScope.name}]`),
      clientSpanParentIsServer: client
        ? client.parentSpanContext?.spanId === parentSpanId
        : null,
      // Which span id the outgoing traceparent names: the client span, or (when the
      // instrumentation's tracer is a no-op) the server span it passes through.
      traceparentSpanId: seen[0]?.split("-")[2] ?? null,
      clientSpanId: client?.spanContext().spanId ?? null,
      serverSpanId: parentSpanId,
    })}\n`,
  );
  server.close();
  process.exit(0);
})();
