// Shared scenario runtime: boots a Nest app on the chosen adapter, prints
// `READY {"port":N}`, waits for `FINISH` on stdin, then prints `RESULT {...}` and
// exits. The Vitest parent drives requests from outside, so its own HTTP calls are
// never instrumented by the process under test.

import http from "node:http";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

export async function createAdapter(name) {
  switch (name) {
    case "express": {
      const { ExpressAdapter } = await import("@nestjs/platform-express");
      return new ExpressAdapter();
    }
    case "fastify": {
      const { FastifyAdapter } = await import("@nestjs/platform-fastify");
      return new FastifyAdapter();
    }
    case "node": {
      const { NodeAdapter } = await import("@nestjs/platform-node");
      return new NodeAdapter();
    }
    default:
      throw new Error(`unknown adapter ${name}`);
  }
}

export function httpGetStatus(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      })
      .on("error", reject);
  });
}

/**
 * `GET /s3/work`: host application code, written against the HOST's copy of
 * @opentelemetry/api (the .cjs copy in a CommonJS host). After an `await` it reads
 * the active span (the server span Nestrix started through the ESM copy), opens its
 * own active span, awaits again, and calls out with fetch and node:http.
 */
export function makeProbeController(hostApi, outUrl) {
  class ProbeController {
    async work() {
      await sleep(5);
      const seen = hostApi.trace.getActiveSpan()?.spanContext();
      return hostApi.trace
        .getTracer("host-app")
        .startActiveSpan("host.work", async (span) => {
          try {
            await sleep(5);
            const url = outUrl();
            const res = await fetch(url);
            await res.arrayBuffer();
            const httpStatus = await httpGetStatus(url);
            return {
              seenActiveSpanId: seen?.spanId ?? null,
              seenActiveTraceId: seen?.traceId ?? null,
              hostWorkSpanId: span.spanContext().spanId,
              fetchStatus: res.status,
              httpStatus,
            };
          } finally {
            span.end();
          }
        });
    }
  }
  Controller("s3")(ProbeController);
  Get("work")(
    ProbeController.prototype,
    "work",
    Object.getOwnPropertyDescriptor(ProbeController.prototype, "work"),
  );
  return ProbeController;
}

export function makeRootModule(imports, controllers = []) {
  class ScenarioRootModule {}
  Module({ imports, controllers })(ScenarioRootModule);
  return ScenarioRootModule;
}

export async function boot(rootModule, adapterName) {
  const adapter = await createAdapter(adapterName);
  const app = await NestFactory.create(rootModule, adapter, { logger: false });
  await app.listen(0, "127.0.0.1");
  const port = app.getHttpServer().address().port;
  globalThis.__scenarioPort = port;
  return { app, port };
}

export function announceReady(port) {
  process.stdout.write(`READY ${JSON.stringify({ port })}\n`);
}

export function waitForFinish() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      if (line.trim() === "FINISH") {
        rl.close();
        resolve();
      }
    });
  });
}

export function emitResult(result) {
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
}

export function spanRecord(span) {
  const sc = span.spanContext();
  return {
    name: span.name,
    kind: span.kind,
    traceId: sc.traceId,
    spanId: sc.spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    scope: span.instrumentationScope?.name,
    attributes: { ...span.attributes },
  };
}
