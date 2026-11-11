// A plain-JavaScript Nest app (decorators applied as functions, as in benchmarks/src/app.mjs) for
// Q3 and Q4, one fresh process per run. Adapter from P7_ADAPTER (express | fastify | node), port
// from PORT (0 = any; the chosen port is sent to the parent).
//
// Routes: GET /hello (trivial), GET /cpu (about 1 ms of JavaScript in `hotRouteWork`).
// IPC: start {api: "v8" | "inspector", intervalMs, maxBufferSize}, stop, memgc (needs
// --expose-gc), stats, opt (needs
// --allow-natives-syntax), exit. Every answer is { id, ok, result }.
import "reflect-metadata";
import { Session } from "node:inspector/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import v8 from "node:v8";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  findFunction,
  medianDelta,
  topFunctions,
  validateProfile,
} from "./validate.mjs";

// biome-ignore format: kept on one line so its position in the profile is easy to check
export function hotRouteWork(n) { let x = 0; for (let i = 0; i < n; i++) x += Math.sqrt(i) * Math.sin(i); return x; }

class AppController {
  hello() {
    return "hello";
  }
  cpu() {
    return String(hotRouteWork(Number(process.env.P7_CPU_ITER ?? 60000)));
  }
}
Controller()(AppController);
for (const [name, path] of [
  ["hello", "hello"],
  ["cpu", "cpu"],
]) {
  Get(path)(
    AppController.prototype,
    name,
    Object.getOwnPropertyDescriptor(AppController.prototype, name),
  );
}
class AppModule {}
Module({ controllers: [AppController] })(AppModule);

async function adapter(name) {
  if (name === "fastify")
    return new (await import("@nestjs/platform-fastify")).FastifyAdapter();
  if (name === "node")
    return new (await import("@nestjs/platform-node")).NodeAdapter();
  return new (await import("@nestjs/platform-express")).ExpressAdapter();
}

const app = await NestFactory.create(
  AppModule,
  await adapter(process.env.P7_ADAPTER ?? "express"),
  {
    logger: ["error", "warn"],
  },
);
await app.listen(Number(process.env.PORT ?? 0), "127.0.0.1");
const port = app.getHttpServer().address().port;

let capture;
const mem = () => {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, external: m.external };
};

const handlers = {
  async start({
    api = "v8",
    intervalMs = 1,
    maxBufferSize,
    debuggerEnable = false,
  }) {
    if (capture) throw new Error("capture already running");
    globalThis.gc?.();
    const before = mem();
    // Event-loop delay across the start call shows whether starting blocks the main thread.
    const h = monitorEventLoopDelay({ resolution: 1 });
    h.enable();
    await new Promise((r) => setTimeout(r, 20));
    const t = performance.now();
    if (api === "v8") {
      const options = { sampleInterval: intervalMs };
      if (maxBufferSize) options.maxBufferSize = maxBufferSize;
      capture = { api, handle: v8.startCpuProfile(options) };
    } else {
      const session = new Session();
      session.connect();
      // Debugger.enable is not needed for a CPU profile; it is here only for Q4's comparison.
      if (debuggerEnable) await session.post("Debugger.enable");
      await session.post("Profiler.enable");
      await session.post("Profiler.setSamplingInterval", {
        interval: intervalMs * 1000,
      });
      await session.post("Profiler.start");
      capture = { api, session };
    }
    const startMs = performance.now() - t;
    await new Promise((r) => setTimeout(r, 20));
    h.disable();
    capture.before = before;
    return {
      startMs,
      loopDelayMaxMs: h.max / 1e6,
      code: v8.getHeapCodeStatistics(),
    };
  },
  async stop() {
    if (!capture) throw new Error("no capture");
    const c = capture;
    capture = undefined;
    const during = mem();
    const t = performance.now();
    let json;
    if (c.api === "v8") {
      json = c.handle.stop();
    } else {
      const { profile } = await c.session.post("Profiler.stop");
      await c.session.post("Profiler.disable");
      c.session.disconnect();
      json = JSON.stringify(profile);
    }
    const stopMs = performance.now() - t;
    const afterStop = mem();
    const t2 = performance.now();
    const profile = JSON.parse(json);
    const parseMs = performance.now() - t2;
    const afterParse = mem();
    return {
      stopMs,
      parseMs,
      jsonBytes: Buffer.byteLength(json),
      samples: profile.samples.length,
      nodes: profile.nodes.length,
      medianDeltaUs: medianDelta(profile),
      problems: validateProfile(profile),
      hot: findFunction(profile, "hotRouteWork"),
      top: topFunctions(profile, 5).map((s) =>
        s.replace(/(file:\/\/)?\/\S*\/(node_modules|spikes)\//, "$2/"),
      ),
      memory: { before: c.before, during, afterStop, afterParse },
    };
  },
  memgc() {
    globalThis.gc?.();
    return mem();
  },
  stats() {
    return { ...mem(), cpu: process.cpuUsage() };
  },
  // %GetOptimizationStatus: Q4 compares the value before and after a capture; any change matters.
  opt() {
    if (!globalThis.__opt)
      globalThis.__opt = new Function("f", "return %GetOptimizationStatus(f)");
    return { hotRouteWork: globalThis.__opt(hotRouteWork) };
  },
  exit() {
    setImmediate(() => process.exit(0));
    return {};
  },
};

process.on("message", async ({ id, cmd, args }) => {
  try {
    process.send({ id, ok: true, result: await handlers[cmd](args ?? {}) });
  } catch (error) {
    process.send({ id, ok: false, error: String(error?.stack ?? error) });
  }
});
process.send({ ready: true, port });
