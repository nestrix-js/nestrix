// Short ingest load against a running server (P5-06; preliminary, the full benchmark is deferred).
// The official OTLP/HTTP protobuf exporter with the batch processor is the load generator.
//
//   node apps/server/scripts/ingest-load.mjs
//
// Env: OTLP_URL (default http://127.0.0.1:4318), DURATION_S (default 45), RATE (target spans per
// second, default 20000), PROVIDERS (parallel tracer providers, default 4), CONTAINERS (comma-separated
// container names to sample with `docker stats`, optional).
// Output: JSON with spans generated, spans the server accepted (export success), spans refused,
// and the sampled CPU and memory. Stored counts are read separately from the database.
import { spawnSync } from "node:child_process";
import { SpanKind } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

const url = process.env.OTLP_URL ?? "http://127.0.0.1:4318";
const durationS = Number(process.env.DURATION_S ?? 45);
const rate = Number(process.env.RATE ?? 20000);
const providers = Number(process.env.PROVIDERS ?? 4);
const containers = (process.env.CONTAINERS ?? "").split(",").filter(Boolean);

let accepted = 0;
let refused = 0;
let clientLimited = 0;
let exports = 0;

const tracers = [];
const processors = [];
for (let p = 0; p < providers; p++) {
  const exporter = new OTLPTraceExporter({ url: `${url}/v1/traces` });
  const original = exporter.export.bind(exporter);
  exporter.export = (spans, done) => {
    exports++;
    try {
      original(spans, (result) => {
        if (result.code === 0) accepted += spans.length;
        else refused += spans.length;
        // Counted here; the processor is told "success" so it never rejects and stops the run.
        done({ code: 0 });
      });
    } catch {
      // The exporter allows 30 requests in flight; past that it throws. That is the load
      // generator saturating (counted as not accepted), not the server refusing.
      clientLimited += spans.length;
      done({ code: 0 });
    }
  };
  const processor = new BatchSpanProcessor({
    exporter,
    maxQueueSize: 200_000,
    maxExportBatchSize: 2048,
    scheduledDelayMillis: 1000,
    exportTimeoutMillis: 30_000,
  });
  processors.push(processor);
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": `load-${p}` }),
    spanProcessors: [processor],
  });
  tracers.push(provider.getTracer("ingest-load"));
}

let generated = 0;
// One trace = a server span with two client children (3 spans), like a request with two queries.
function oneTrace(tracer, now) {
  const root = tracer.startSpan("GET /items/:id", {
    kind: SpanKind.SERVER,
    startTime: now,
    attributes: {
      "http.request.method": "GET",
      "http.route": "/items/:id",
      "http.response.status_code": 200,
    },
  });
  const ctx = await_ctx(root);
  for (let i = 0; i < 2; i++) {
    const child = tracer.startSpan(
      "SELECT items",
      {
        kind: SpanKind.CLIENT,
        startTime: now + 1,
        attributes: { "db.system.name": "postgresql" },
      },
      ctx,
    );
    child.end(now + 2);
  }
  root.end(now + 5);
  generated += 3;
}

import { ROOT_CONTEXT, trace } from "@opentelemetry/api";

function await_ctx(root) {
  return trace.setSpan(ROOT_CONTEXT, root);
}

const samples = [];
function sampleStats() {
  if (!containers.length) return;
  const out = spawnSync(
    "docker",
    [
      "stats",
      "--no-stream",
      "--format",
      "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}",
      ...containers,
    ],
    { encoding: "utf8" },
  ).stdout;
  for (const line of out.trim().split("\n")) {
    const [name, cpu, mem] = line.split("|");
    samples.push({ name, cpu, mem: mem?.split(" / ")[0] });
  }
}

const start = Date.now();
const tickMs = 50;
let tick = 0;
const statsTimer = setInterval(sampleStats, 8000);
await new Promise((resolve) => {
  const timer = setInterval(() => {
    const elapsed = Date.now() - start;
    if (elapsed >= durationS * 1000) {
      clearInterval(timer);
      resolve();
      return;
    }
    const due = Math.floor((elapsed / 1000) * rate);
    while (generated < due) {
      oneTrace(tracers[tick++ % providers], Date.now());
    }
  }, tickMs);
});
const loadEnd = Date.now();
await Promise.all(processors.map((p) => p.forceFlush()));
const flushedAt = Date.now();
clearInterval(statsTimer);

console.log(
  JSON.stringify(
    {
      loadSeconds: (loadEnd - start) / 1000,
      secondsUntilFlushed: (flushedAt - start) / 1000,
      targetSpansPerSecond: rate,
      generated,
      accepted,
      refused,
      clientLimited,
      exportRequests: exports,
      acceptedPerSecond: Math.round(accepted / ((flushedAt - start) / 1000)),
      samples,
    },
    null,
    2,
  ),
);
process.exit(0);
