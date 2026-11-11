// Q3 from an ESM host: same as q3-detect.cjs, one api copy shared with Nestrix.
import * as api from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import * as sdk from "@opentelemetry/sdk-trace";
import { probeAll } from "./lib/q3-probe.mjs";

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

const r = await probeAll({ diagMessages, hostExporter });
process.stdout.write(
  `RESULT ${JSON.stringify({ host: "esm", mode, node: process.version, ...r })}\n`,
);
