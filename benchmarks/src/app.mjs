// The benchmark app, one fresh process per run. Same routes as examples/express-esm
// (`GET /hello`, `GET /users/:id`) through its `AppModule`, plus, for Nestrix configurations only,
// `GET /spans`: a route that creates three spans with `withSpan`, so the export queue has something
// to buffer while HTTP server spans (P1-06) do not exist yet.
//
// Configuration comes from the environment: BENCH_CONFIG (baseline | noexport | sink | unreachable |
// blackhole | upstream), PORT, BENCH_ENDPOINT, BENCH_QUEUE_SIZE. The parent talks to it over IPC:
// `stats` (CPU, memory, Nestrix span counters, outgoing connection counts), `gcstats` (the same after a forced GC; needs
// --expose-gc) and `stop` (app.close(), then exit).
import { subscribe } from "node:diagnostics_channel";
import "reflect-metadata";
import { getHeapSpaceStatistics, getHeapStatistics } from "node:v8";
import { Controller, Get, Module } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";

// Outgoing TCP connections the app opens (the exporter's; the app makes no other), counted from
// Node's own `net.client.socket` channel so an unreachable endpoint, which has no server to count
// at, is covered too. In flight means created and not yet closed, including idle keep-alive sockets.
const conn = { created: 0, inFlight: 0, maxInFlight: 0 };
subscribe("net.client.socket", (message) => {
  try {
    conn.created++;
    conn.inFlight++;
    if (conn.inFlight > conn.maxInFlight) conn.maxInFlight = conn.inFlight;
    message.socket.once("close", () => {
      conn.inFlight--;
    });
  } catch {
    // counting must never affect the app
  }
});

// Young-generation collections (kind minor = scavenge), counted only when BENCH_GC_COUNT=1 (P2-15).
const gcCounts = { scavenges: 0, major: 0 };
if (process.env.BENCH_GC_COUNT === "1") {
  const { PerformanceObserver, constants } = await import("node:perf_hooks");
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.detail?.kind === constants.NODE_PERFORMANCE_GC_MINOR)
        gcCounts.scavenges++;
      else gcCounts.major++;
    }
  }).observe({ entryTypes: ["gc"] });
}

const config = process.env.BENCH_CONFIG ?? "baseline";
const port = Number(process.env.PORT ?? 3000);
const usesNestrix = [
  "noexport",
  "headless",
  "dashboard",
  "headless-eager",
  "sink",
  "unreachable",
  "blackhole",
].includes(config);

const { AppModule } = await import("express-esm/app.module");
const imports = [AppModule];
const controllers = [];
let core;
let storeModule;

if (usesNestrix) {
  const { NestrixModule, withSpan } = await import("@nestrix-js/nestjs");
  // Counters are not public API yet; read them from the built package next to its entry point.
  try {
    core = await import(
      new URL("core.js", import.meta.resolve("@nestrix-js/nestjs")).href
    );
  } catch {
    core = undefined;
  }
  const options = {};
  // `headless` and `dashboard` differ only in `ui`; neither exports.
  if (config === "headless" || config === "headless-eager") options.ui = false;
  if (config === "dashboard") options.ui = "auto";
  // "Before P2-14": load the exporter graph at startup, as the pipeline did before it became lazy.
  if (process.env.BENCH_EAGER_EXPORTER) {
    // Not a dependency of this package: resolve it as @nestrix-js/nestjs does, and take the same ESM
    // entry its dynamic import gets (require.resolve returns the .cjs sibling).
    const { createRequire } = await import("node:module");
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const cjs = createRequire(
      fileURLToPath(import.meta.resolve("@nestrix-js/nestjs")),
    ).resolve("@opentelemetry/exporter-trace-otlp-http");
    await import(pathToFileURL(cjs.replace(/index\.cjs$/, "index.mjs")).href);
  }
  if (
    !["noexport", "headless", "dashboard", "headless-eager"].includes(config)
  ) {
    options.export = { otlp: { endpoint: process.env.BENCH_ENDPOINT } };
    if (process.env.BENCH_QUEUE_SIZE) {
      options.export.queue = {
        maxQueueSize: Number(process.env.BENCH_QUEUE_SIZE),
      };
    }
  }
  // The dashboard's store is internal; read its counters from the built package, as above.
  try {
    storeModule = await import(
      new URL("store/index.js", import.meta.resolve("@nestrix-js/nestjs")).href
    );
  } catch {
    storeModule = undefined;
  }
  imports.push(NestrixModule.forRoot(options));

  class SpansController {
    run() {
      return withSpan("bench.outer", () => {
        withSpan("bench.inner.a", () => 1);
        withSpan("bench.inner.b", () => 2);
        return "ok";
      });
    }
  }
  Controller()(SpansController);
  Get("spans")(
    SpansController.prototype,
    "run",
    Object.getOwnPropertyDescriptor(SpansController.prototype, "run"),
  );
  controllers.push(SpansController);
}

// `interceptor`: the uninstrumented app plus one global interceptor that only returns
// next.handle(), to separate Nest's own per-request cost of having any interceptor.
const providers = [];
if (config === "interceptor") {
  class NoopInterceptor {
    intercept(_context, next) {
      return next.handle();
    }
  }
  providers.push({ provide: APP_INTERCEPTOR, useClass: NoopInterceptor });
}

class BenchModule {}
Module({ imports, controllers, providers })(BenchModule);

const app = await NestFactory.create(BenchModule, {
  logger: ["error", "warn"],
});
app.enableShutdownHooks();
await app.listen(port, "127.0.0.1");

function snapshot(withGc) {
  if (withGc) globalThis.gc?.();
  const cpu = process.cpuUsage();
  const mem = process.memoryUsage();
  let counters;
  try {
    counters = core
      ? {
          ...app.get(core.NestrixCore, { strict: false }).telemetry?.counters,
        }
      : undefined;
  } catch {
    counters = undefined;
  }
  return {
    cpuUserUs: cpu.user,
    cpuSystemUs: cpu.system,
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    allocatedBytes: getHeapStatistics().total_allocated_bytes,
    gc: { ...gcCounts },
    modules: globalThis.__benchLoadedModules?.size,
    spaces: Object.fromEntries(
      getHeapSpaceStatistics().map((s) => [
        s.space_name,
        { size: s.space_size, used: s.space_used_size },
      ]),
    ),
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    counters,
    store: storeModule?.getStore()?.stats(),
    connections: { ...conn },
  };
}

process.on("message", async (m) => {
  if (m?.type === "stats") process.send({ type: "stats", ...snapshot(false) });
  else if (m?.type === "gcstats")
    process.send({ type: "gcstats", ...snapshot(true) });
  else if (m?.type === "modules")
    process.send({
      type: "modules",
      urls: [...(globalThis.__benchLoadedModules ?? [])],
    });
  else if (m?.type === "allocprof-start") {
    // Sampling allocation profile that keeps objects later collected by GC, so it shows
    // what is allocated per request, not only what survives.
    const { Session } = await import("node:inspector/promises");
    globalThis.__benchSession = new Session();
    globalThis.__benchSession.connect();
    await globalThis.__benchSession.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    process.send({ type: "allocprof-start" });
  } else if (m?.type === "allocprof-stop") {
    const { profile } = await globalThis.__benchSession.post(
      "HeapProfiler.stopSampling",
    );
    const { writeFileSync } = await import("node:fs");
    const path =
      m.path ??
      `${process.env.BENCH_OUT_DIR ?? "."}/allocprof-${process.pid}.json`;
    writeFileSync(path, JSON.stringify(profile));
    process.send({ type: "allocprof-stop", path });
  } else if (m?.type === "heapsnapshot") {
    globalThis.gc?.();
    const { writeHeapSnapshot } = await import("node:v8");
    process.send({ type: "heapsnapshot", path: writeHeapSnapshot(m.path) });
  } else if (m?.type === "stop") {
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  }
});
