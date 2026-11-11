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
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

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

const config = process.env.BENCH_CONFIG ?? "baseline";
const port = Number(process.env.PORT ?? 3000);
const usesNestrix = ["noexport", "sink", "unreachable", "blackhole"].includes(
  config,
);

const { AppModule } = await import("express-esm/app.module");
const imports = [AppModule];
const controllers = [];
let core;

if (usesNestrix) {
  const { NestrixModule, withSpan } = await import("@nestrix/nestjs");
  // Counters are not public API yet; read them from the built package next to its entry point.
  try {
    core = await import(
      new URL("core.js", import.meta.resolve("@nestrix/nestjs")).href
    );
  } catch {
    core = undefined;
  }
  const options = {};
  if (config !== "noexport") {
    options.export = { otlp: { endpoint: process.env.BENCH_ENDPOINT } };
    if (process.env.BENCH_QUEUE_SIZE) {
      options.export.queue = {
        maxQueueSize: Number(process.env.BENCH_QUEUE_SIZE),
      };
    }
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

class BenchModule {}
Module({ imports, controllers })(BenchModule);

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
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    counters,
    connections: { ...conn },
  };
}

process.on("message", async (m) => {
  if (m?.type === "stats") process.send({ type: "stats", ...snapshot(false) });
  else if (m?.type === "gcstats")
    process.send({ type: "gcstats", ...snapshot(true) });
  else if (m?.type === "stop") {
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  }
});
