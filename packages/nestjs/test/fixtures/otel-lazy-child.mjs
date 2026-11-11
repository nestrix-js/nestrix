// Child process for otel-lazy-exporter.test.ts. argv[2] is the OTLP URL or "off".
// A module `load` hook (registered before anything of Nestrix's is imported) records
// every module URL Node loads, so the parent can tell whether the OTLP exporter graph
// was loaded. With a URL, it ends one span synchronously right after setup and shuts
// down at once, so the span ends and shutdown runs while the exporter is still loading.
import { registerHooks } from "node:module";

const loaded = [];
registerHooks({
  load(url, context, next) {
    loaded.push(url);
    return next(url, context);
  },
});

const { trace } = await import("@opentelemetry/api");
const { setupTelemetry } = await import("../../src/otel/setup.ts");

const url = process.argv[2];
const handle = setupTelemetry(
  {
    serviceName: "lazy-child",
    resourceAttributes: {},
    sampleRate: 1,
    redact: undefined,
    export: {
      otlp: url === "off" ? false : { url, headers: {}, timeoutMillis: 5000 },
      queue: {
        maxQueueSize: 100,
        maxExportBatchSize: 10,
        scheduledDelayMillis: 10,
      },
    },
    shutdownTimeoutMillis: 5000,
  },
  { logOnce() {}, countFailure() {} },
);
trace.getTracer("child").startSpan("early").end();
await handle.shutdown();
const exporterModules = loaded.filter((u) =>
  /exporter-trace-otlp-http|sdk-metrics/.test(u),
);
process.stdout.write(
  `${JSON.stringify({ exporterModules: exporterModules.length, counters: handle.counters })}\n`,
);
