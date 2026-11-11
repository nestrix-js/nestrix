// Control for early-tracer.cjs: one api copy (ESM host). A tracer taken before the
// provider is registered should start recording once it is, because ProxyTracer
// looks up its delegate lazily on the proxy provider that registration fills in.
import * as api from "@opentelemetry/api";
import * as sdk from "@opentelemetry/sdk-trace";

const early = api.trace.getTracer("host-early");
const firstSpan = early.startSpan("before-registration");
const before = api.isSpanContextValid(firstSpan.spanContext());
firstSpan.end();

const exporter = new sdk.InMemorySpanExporter();
const registered = api.trace.setGlobalTracerProvider(
  new sdk.TracerProvider({
    spanProcessors: [new sdk.SimpleSpanProcessor({ exporter })],
  }),
);
const span = early.startSpan("early-after");
const after = api.isSpanContextValid(span.spanContext());
span.end();
process.stdout.write(
  `RESULT ${JSON.stringify({
    case: "same-copy",
    node: process.version,
    registered,
    earlyBeforeRegistration: before,
    earlyAfterRegistration: after,
    exported: exporter.getFinishedSpans().map((s) => s.name),
  })}\n`,
);
