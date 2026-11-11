// CommonJS fixture entry. Compiled to CommonJS (cjs/package.json says "type": "commonjs")
// and run with plain `node cjs/dist/main.js`: no flags. The stand-in Nestrix package is
// ESM-only, as @nestrix-js/nestjs will be, so it is loaded with require(esm).
import "reflect-metadata";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Controller, Get, Module, Param } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { trace } from "@opentelemetry/api";
import Redis from "ioredis";
import mysql from "mysql2/promise";
import pg from "pg";
import {
  enableReport,
  failures,
  finishedSpans,
  httpChannelsSeen,
  SpikeNestrixModule,
} from "../../dist/src/nestrix/index.js";

// Taken per call, not at module top level: a tracer taken from the CommonJS build of
// @opentelemetry/api before the ESM-only library registers its provider stays a no-op
// forever (dual-package hazard, see scripts/dual-api.cjs and the result file).
async function withSpan<T>(name: string, fn: () => Promise<T>) {
  const tracer = trace.getTracer("fixture-app-cjs");
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn();
      return { spanId: span.spanContext().spanId, result };
    } finally {
      span.end();
    }
  });
}

function httpGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      })
      .on("error", reject);
  });
}

const env = process.env;

@Controller("s")
class ScenarioController {
  @Get(":name")
  async run(@Param("name") name: string): Promise<unknown> {
    switch (name) {
      case "out":
        return withSpan("handler out", async () => {
          const res = await fetch(`${env.ECHO_URL}/fetch`);
          await res.arrayBuffer();
          return {
            fetch: res.status,
            http: await httpGet(`${env.ECHO_URL}/http`),
          };
        });
      case "pg": {
        const client = new pg.Client({ connectionString: env.PG_URL });
        const pool = new pg.Pool({ connectionString: env.PG_URL, max: 1 });
        await client.connect();
        try {
          return await withSpan("handler pg", async () => ({
            client: (await client.query("SELECT 1 AS n")).rows,
            pool: (await pool.query("SELECT 2 AS n")).rows,
            callback: await new Promise((resolve, reject) =>
              client.query("SELECT 3 AS n", (e, r) =>
                e ? reject(e) : resolve(r.rows),
              ),
            ),
          }));
        } finally {
          await client.end();
          await pool.end();
        }
      }
      case "mysql": {
        const pool = mysql.createPool({
          uri: env.MYSQL_URL,
          connectionLimit: 1,
        });
        try {
          return await withSpan("handler mysql", async () => ({
            query: (await pool.query("SELECT 1 AS n"))[0],
            execute: (await pool.execute("SELECT ? AS n", [2]))[0],
          }));
        } finally {
          await pool.end();
        }
      }
      case "redis": {
        const redis = new Redis(env.REDIS_URL as string);
        await new Promise((r) => redis.once("ready", r));
        try {
          return await withSpan("handler redis", async () => ({
            set: await redis.set("nestrix:s2:cjs", "v"),
            get: await redis.get("nestrix:s2:cjs"),
          }));
        } finally {
          await redis.quit();
        }
      }
      default:
        return { unknown: name };
    }
  }
}

@Module({
  imports: [SpikeNestrixModule.forRoot()],
  controllers: [ScenarioController],
})
class AppModule {}

async function main() {
  const received: Array<{ path: string; traceparent: unknown }> = [];
  const echo = http.createServer((req, res) => {
    received.push({
      path: req.url ?? "",
      traceparent: req.headers.traceparent,
    });
    res.end("ok");
  });
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  env.ECHO_URL = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  const app = await NestFactory.create(AppModule, new ExpressAdapter(), {
    logger: false,
  });
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  const responses: Record<string, unknown> = {};
  for (const name of (env.SCENARIOS ?? "out").split(",")) {
    const res = await fetch(`http://127.0.0.1:${port}/s/${name}`);
    responses[name] = { status: res.status, body: await res.json() };
  }
  await app.close();
  echo.closeAllConnections();
  await new Promise((r) => echo.close(r));
  await new Promise((r) => setTimeout(r, 100));
  const result = {
    format: "cjs",
    moduleType: typeof module === "object" && typeof require === "function",
    node: process.version,
    execArgv: process.execArgv,
    nodeOptions: env.NODE_OPTIONS ?? "",
    nestPort: port,
    enable: enableReport(),
    responses,
    received,
    spans: finishedSpans(),
    failures,
    httpChannelsSeen,
  };
  process.stdout.write(`__P0S2_RESULT__${JSON.stringify(result)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
