// Q3 from a CommonJS host: the host registers through the .cjs api copy, Nestrix
// probes through the .mjs copy. S3_HOST picks what the host registers:
//   none | all | provider | context | propagator | stack-context
// The host installs a diag logger at WARN so any noise Nestrix causes is visible.
const api = require("@opentelemetry/api");
const {
  AsyncLocalStorageContextManager,
} = require("@opentelemetry/context-async-hooks");
const { W3CTraceContextPropagator } = require("@opentelemetry/core");
const sdk = require("@opentelemetry/sdk-trace");

const mode = process.env.S3_HOST ?? "none";
const diagMessages = [];
const sink = (...args) => diagMessages.push(args.map(String).join(" "));
api.diag.setLogger(
  { error: sink, warn: sink, info: sink, debug: sink, verbose: sink },
  api.DiagLogLevel.WARN,
);

let hostExporter;
const want = (x) => mode === "all" || mode === x;
if (want("provider")) {
  hostExporter = new sdk.InMemorySpanExporter();
  api.trace.setGlobalTracerProvider(
    new sdk.TracerProvider({
      spanProcessors: [new sdk.SimpleSpanProcessor({ exporter: hostExporter })],
    }),
  );
}
if (want("context")) {
  api.context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
}
if (mode === "stack-context") {
  api.context.setGlobalContextManager(new sdk.StackContextManager().enable());
}
if (want("propagator")) {
  api.propagation.setGlobalPropagator(new W3CTraceContextPropagator());
}

const { probeAll } = require("./lib/q3-probe.mjs");
probeAll({ diagMessages, hostExporter }).then((r) => {
  process.stdout.write(
    `RESULT ${JSON.stringify({ host: "cjs", mode, node: process.version, ...r })}\n`,
  );
});
