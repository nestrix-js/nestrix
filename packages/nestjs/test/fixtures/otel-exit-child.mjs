// Child process for otel-shutdown-bound.test.ts: sets up the owned pipeline against
// URL (argv[2]) with exporter timeout argv[3] and shutdown bound argv[4], queues spans,
// shuts down, and prints one JSON line. The parent measures when the process exits.
import { trace } from "@opentelemetry/api";
import { setupTelemetry } from "../../src/otel/setup.ts";

const [url, timeoutMillis, bound] = process.argv.slice(2);
const handle = setupTelemetry(
  {
    serviceName: "exit-child",
    resourceAttributes: {},
    sampleRate: 1,
    redact: undefined,
    export: {
      otlp: { url, headers: {}, timeoutMillis: Number(timeoutMillis) },
      queue: {
        maxQueueSize: 100,
        maxExportBatchSize: 10,
        scheduledDelayMillis: 10,
      },
    },
    shutdownTimeoutMillis: Number(bound),
  },
  { logOnce() {}, countFailure() {} },
);
for (let i = 0; i < 25; i++) trace.getTracer("child").startSpan(`s${i}`).end();
// Let the first export start, so a request is in flight (or in retry backoff).
await new Promise((r) => setTimeout(r, 200));
const started = Date.now();
await handle.shutdown();
process.stdout.write(
  `${JSON.stringify({ shutdownMs: Date.now() - started, counters: handle.counters })}\n`,
);
