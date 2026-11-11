// Manual probe, not run by Vitest: the owned export pipeline under a collector outage,
// against a healthy collector as the control. Produces the outage figures in
// docs/research.md "Export pipeline facts"; the P1-13 benchmarks are the reference.
//
//   node --expose-gc --import ./test/fixtures/ts-hooks.mjs \
//     test/manual/otel-outage-probe.mjs <healthy|refused|blackhole> \
//     [timeoutMillis=10000] [seconds=150] [spansPerSecond=20000]
//
// (On Node 22 add --experimental-strip-types.) Run from packages/nestjs. Collectors:
// healthy answers 200 with an empty body; refused closes its port (ECONNREFUSED);
// blackhole accepts connections and never answers. Every second, after a forced GC, it
// samples RSS, heapUsed and the collector's open sockets (the exporter's concurrency:
// `IncomingMessage` `close` fires once the body is read, so requests cannot be counted
// that way). Prints one JSON line with the samples and a summary:
// - maxOpenSockets: the most sockets open at once, at any moment (not only at samples),
//   including the final flush at shutdown, which is not limited to one export;
// - maxOpenSocketsBeforeShutdown: the same, up to the moment shutdown starts;
// - heapAfterGcMB: median and max of heapUsed after GC from second 30 on;
// - rssSlopeMBPerMin: least-squares slope of RSS from second 60 on;
// - rssGrowthAfter60MB: peak RSS minus the RSS sample at second 60 (the benchmark's
//   current metric, kept for comparison).
import { once } from "node:events";
import { createServer } from "node:http";
import { trace } from "@opentelemetry/api";
import { setupTelemetry } from "../../src/otel/setup.ts";

const mode = process.argv[2] ?? "blackhole";
const timeoutMillis = Number(process.argv[3] ?? 10_000);
const seconds = Number(process.argv[4] ?? 150);
const spansPerSecond = Number(process.argv[5] ?? 20_000);
if (!["healthy", "refused", "blackhole"].includes(mode)) {
  throw new Error(`unknown mode ${mode}`);
}

let open = 0;
let maxOpen = 0;
let requests = 0;
const server = createServer((req, res) => {
  requests++;
  req.resume();
  if (mode === "healthy") {
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      res.end();
    });
  }
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
const perTick = Math.round(spansPerSecond / 10);
const produce = setInterval(() => {
  for (let i = 0; i < perTick; i++) {
    trace.getTracer("outage").startSpan("s", { attributes: { pad } }).end();
  }
}, 100);

const samples = []; // [second, rssMB, heapMB, openSockets]
const started = Date.now();
const sample = setInterval(() => {
  globalThis.gc?.();
  const m = process.memoryUsage();
  samples.push([
    Math.round((Date.now() - started) / 1000),
    +(m.rss / 1e6).toFixed(1),
    +(m.heapUsed / 1e6).toFixed(1),
    open,
  ]);
}, 1000);
await new Promise((r) => setTimeout(r, seconds * 1000));
clearInterval(produce);
clearInterval(sample);

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}
function slope(points) {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((a, p) => a + p[0], 0) / n;
  const my = points.reduce((a, p) => a + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}
const late = samples.filter((s) => s[0] >= 30);
const afterMinute = samples.filter((s) => s[0] >= 60);
const at60 = afterMinute[0]?.[1];
const maxOpenBeforeShutdown = maxOpen;
const shutdownStarted = Date.now();
await handle.shutdown();
console.log(
  JSON.stringify({
    mode,
    timeoutMillis,
    seconds,
    spansPerSecond,
    node: process.version,
    summary: {
      maxOpenSockets: maxOpen,
      maxOpenSocketsBeforeShutdown: maxOpenBeforeShutdown,
      maxOpenSocketsAtSamples: Math.max(0, ...samples.map((s) => s[3])),
      requests,
      heapAfterGcMB: {
        median: median(late.map((s) => s[2])),
        max: Math.max(...late.map((s) => s[2])),
      },
      rssSlopeMBPerMin:
        afterMinute.length > 1
          ? +(slope(afterMinute.map((s) => [s[0], s[1]])) * 60).toFixed(2)
          : null,
      rssGrowthAfter60MB:
        at60 === undefined
          ? null
          : +(Math.max(...afterMinute.map((s) => s[1])) - at60).toFixed(1),
      shutdownMs: Date.now() - shutdownStarted,
    },
    counters: handle.counters,
    samples,
  }),
);
server.closeAllConnections?.();
server.close();
