// Manual probe, not run by Vitest: the owned export pipeline under a collector outage.
// Produces the provisional figures in docs/research.md "Export pipeline facts" until the
// P1-13 benchmarks replace them.
//
//   node --expose-gc --import ./test/fixtures/ts-hooks.mjs \
//     test/manual/otel-outage-probe.mjs <refused|blackhole> [timeoutMillis=1000] [seconds=20]
//
// (On Node 22 add --experimental-strip-types.) Run from packages/nestjs. Prints one JSON
// line: the most export requests the collector saw in flight at once, the counters, and
// "rss/heapUsed" in MB sampled every second after a forced GC.
import { once } from "node:events";
import { createServer } from "node:http";
import { trace } from "@opentelemetry/api";
import { setupTelemetry } from "../../src/otel/setup.ts";

const mode = process.argv[2] ?? "blackhole";
const timeoutMillis = Number(process.argv[3] ?? 1000);
const seconds = Number(process.argv[4] ?? 20);

let open = 0;
let maxOpen = 0;
let requests = 0;
const server = createServer((req) => {
  requests++;
  req.resume();
});
server.on("connection", (socket) => {
  open++;
  maxOpen = Math.max(maxOpen, open);
  socket.on("close", () => open--);
  socket.on("error", () => {});
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}/v1/traces`;
if (mode === "refused") server.close();

const handle = setupTelemetry(
  {
    serviceName: "outage-probe",
    resourceAttributes: {},
    sampleRate: 1,
    redact: undefined,
    export: {
      otlp: { url, headers: {}, timeoutMillis },
      queue: {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 200,
      },
    },
    shutdownTimeoutMillis: 2000,
  },
  { logOnce() {}, countFailure: (where, error) => console.error(where, error) },
);

const pad = "x".repeat(200);
const rss0 = process.memoryUsage().rss;
const produce = setInterval(() => {
  // 20,000 spans/s.
  for (let i = 0; i < 2000; i++) {
    trace.getTracer("outage").startSpan("s", { attributes: { pad } }).end();
  }
}, 100);
const samples = [];
const sample = setInterval(() => {
  globalThis.gc?.();
  const m = process.memoryUsage();
  samples.push(`${Math.round(m.rss / 1e6)}/${Math.round(m.heapUsed / 1e6)}`);
}, 1000);
await new Promise((r) => setTimeout(r, seconds * 1000));
clearInterval(produce);
clearInterval(sample);
const started = Date.now();
await handle.shutdown();
console.log(
  JSON.stringify({
    mode,
    timeoutMillis,
    seconds,
    node: process.version,
    maxConcurrentConnections: maxOpen,
    requests,
    counters: handle.counters,
    rss0MB: Math.round(rss0 / 1e6),
    rssHeapMB: samples,
    shutdownMs: Date.now() - started,
  }),
);
server.closeAllConnections?.();
server.close();
