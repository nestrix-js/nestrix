// Child process of ingest-memory.mjs: the standalone server (apps/server/dist, built) with a
// configured in-flight budget, plus probes that only observe:
//   - a 1 ms sampler of process.memoryUsage() on the main thread,
//   - a worker thread sampling the process RSS every 1 ms (it keeps sampling while the main
//     thread is busy decoding),
//   - a wrapper around Buffer.concat that samples memory right after each large concat (the
//     moment the chunks and the contiguous copy are both live),
//   - wrappers around ByteBudget.tryTake/release that record the peak of what is charged.
// Configuration comes as JSON in NESTRIX_MEM_CONFIG: { sink: "postgres" | "memory",
// databaseUrl, budgetBytes, maxBodyBytes, sinkDelayMs }. Talks to the parent over IPC.
import "reflect-metadata";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "apps", "server", "dist");
const load = (p) => import(pathToFileURL(join(dist, p)).href);

const cfg = JSON.parse(process.env.NESTRIX_MEM_CONFIG ?? "{}");

const { loadConfig } = await load("config.js");
const limits = await load("ingest/limits.js");
const { INGEST_SINK } = await load("ingest/tokens.js");

// --- probes -------------------------------------------------------------------------------
const peak = {
  rss: 0,
  heapUsed: 0,
  external: 0,
  arrayBuffers: 0,
  extPlusHeap: 0,
  workerRss: 0,
  charged: 0,
  concat: { count: 0, maxArrayBuffers: 0, maxCharged: 0 },
};
let sampling = false;
const sample = () => {
  const m = process.memoryUsage();
  if (m.rss > peak.rss) peak.rss = m.rss;
  if (m.heapUsed > peak.heapUsed) peak.heapUsed = m.heapUsed;
  if (m.external > peak.external) peak.external = m.external;
  if (m.arrayBuffers > peak.arrayBuffers) peak.arrayBuffers = m.arrayBuffers;
  if (m.external + m.heapUsed > peak.extPlusHeap)
    peak.extPlusHeap = m.external + m.heapUsed;
  return m;
};
setInterval(() => {
  if (sampling) sample();
}, 1).unref();

const worker = new Worker(
  `const { parentPort } = require("node:worker_threads");
   let peak = 0;
   setInterval(() => { const r = process.memoryUsage.rss(); if (r > peak) peak = r; }, 1);
   parentPort.on("message", (m) => {
     if (m === "reset") peak = 0;
     else parentPort.postMessage(peak);
   });`,
  { eval: true },
);
worker.unref();
const workerPeak = () =>
  new Promise((resolve) => {
    worker.once("message", resolve);
    worker.postMessage("get");
  });

const originalConcat = Buffer.concat;
let budgetRef;
Buffer.concat = function concat(list, total) {
  const out = originalConcat.call(Buffer, list, total);
  if (sampling && out.length >= 1024 * 1024) {
    const m = sample();
    peak.concat.count++;
    if (m.arrayBuffers > peak.concat.maxArrayBuffers)
      peak.concat.maxArrayBuffers = m.arrayBuffers;
    const inUse = budgetRef?.inUse ?? 0;
    if (inUse > peak.concat.maxCharged) peak.concat.maxCharged = inUse;
  }
  return out;
};

const proto = limits.ByteBudget.prototype;
const originalTake = proto.tryTake;
proto.tryTake = function tryTake(bytes) {
  budgetRef = this;
  const ok = originalTake.call(this, bytes);
  if (ok && this.inUse > peak.charged) peak.charged = this.inUse;
  return ok;
};

// --- server -------------------------------------------------------------------------------
const env = {
  DATABASE_URL: cfg.databaseUrl ?? "postgres://127.0.0.1:1/unused",
  NESTRIX_INGEST_AUTH: "none",
  NESTRIX_LOG_LEVEL: "error",
  // The harness sends far more than 100 requests per second from one address.
  ...cfg.env,
};
const result = loadConfig(env);
if (!result.ok) throw new Error(result.errors.join("\n"));
const config = {
  ...result.config,
  ingest: {
    ...result.config.ingest,
    rateLimit: { requestsPerSecond: 100_000, burst: 100_000 },
    ...(cfg.budgetBytes ? { inflightBudgetBytes: cfg.budgetBytes } : {}),
    ...(cfg.maxBodyBytes ? { maxBodyBytes: cfg.maxBodyBytes } : {}),
  },
};

let app;
if (cfg.sink === "memory") {
  const { NestFactory } = await import(
    pathToFileURL(
      join(
        here,
        "..",
        "..",
        "apps",
        "server",
        "node_modules",
        "@nestjs",
        "core",
        "index.js",
      ),
    ).href
  );
  const { AppModule } = await load("app.module.js");
  const { configureApp } = await load("bootstrap.js");
  app = await NestFactory.create(
    AppModule.forRoot(config, { inMemory: true }),
    {
      bodyParser: false,
      logger: false,
    },
  );
  configureApp(app, config);
} else {
  const { createApp } = await load("bootstrap.js");
  app = await createApp(config);
}
if ((cfg.sinkDelayMs ?? 0) > 0) {
  // Hold each accepted batch for a while, as a slow database would (the receiver keeps its
  // charge until the sink answers).
  const sink = app.get(INGEST_SINK);
  const write = sink.write.bind(sink);
  sink.write = async (batch) => {
    await new Promise((r) => setTimeout(r, cfg.sinkDelayMs));
    return write(batch);
  };
}
// Standalone (in a container, no IPC): listen on cfg.port on every interface, sample from the
// start, and print the peaks every second so they survive an OOM kill.
const standalone = typeof process.send !== "function";
await app.listen(
  standalone ? (cfg.port ?? 4318) : 0,
  standalone ? "0.0.0.0" : "127.0.0.1",
);
const port = app.getHttpServer().address().port;
if (standalone) {
  const base = process.memoryUsage();
  sampling = true;
  console.log(JSON.stringify({ type: "ready", port, base }));
  setInterval(async () => {
    console.log(
      JSON.stringify({
        type: "peak",
        charged: peak.charged,
        rss: Math.max(peak.rss, await workerPeak()),
        arrayBuffers: peak.arrayBuffers,
        heapUsed: peak.heapUsed,
        capacity: config.ingest.inflightBudgetBytes,
      }),
    );
  }, 1000);
}

process.on("message", async (msg) => {
  try {
    if (msg.type === "baseline") {
      for (let i = 0; i < 4; i++) {
        globalThis.gc?.();
        await new Promise((r) => setTimeout(r, 20));
      }
      const base = process.memoryUsage();
      for (const k of Object.keys(peak))
        if (typeof peak[k] === "number") peak[k] = 0;
      peak.concat = { count: 0, maxArrayBuffers: 0, maxCharged: 0 };
      worker.postMessage("reset");
      sampling = true;
      process.send({ type: "baseline", base });
    } else if (msg.type === "report") {
      sampling = false;
      const wp = await workerPeak();
      const inUse = budgetRef?.inUse ?? 0;
      globalThis.gc?.();
      process.send({
        type: "report",
        peak: { ...peak, workerRss: wp },
        inUseAfter: inUse,
        capacity: config.ingest.inflightBudgetBytes,
        maxBodyBytes: config.ingest.maxBodyBytes,
        after: process.memoryUsage(),
      });
    } else if (msg.type === "close") {
      await app.close();
      process.exit(0);
    }
  } catch (error) {
    process.send({ type: "error", message: String(error?.stack ?? error) });
  }
});
if (!standalone) process.send({ type: "ready", port });
