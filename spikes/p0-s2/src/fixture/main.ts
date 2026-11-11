// ESM fixture entry. Run with plain `node dist/src/fixture/main.js`: no flags.
import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { NodeAdapter } from "@nestjs/platform-node";
import {
  enableReport,
  failures,
  finishedSpans,
  httpChannelsSeen,
} from "../nestrix/index.js";
import { AppModule } from "./app.module.js";
import { startEcho } from "./echo.js";

async function main() {
  const echo = await startEcho();
  process.env.ECHO_URL = echo.url;
  const adapterName = process.env.ADAPTER ?? "express";
  const adapter =
    adapterName === "fastify"
      ? new FastifyAdapter()
      : adapterName === "node"
        ? new NodeAdapter()
        : new ExpressAdapter();
  const app = await NestFactory.create(AppModule, adapter, { logger: false });
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const scenarios = (process.env.SCENARIOS ?? "out").split(",");
  const responses: Record<string, unknown> = {};
  for (const name of scenarios) {
    const res = await fetch(`${base}/s/${name}`);
    responses[name] = { status: res.status, body: await res.json() };
  }
  await app.close();
  await echo.close();
  await new Promise((r) => setTimeout(r, 100));
  const result = {
    format: "esm",
    adapter: adapterName,
    node: process.version,
    execArgv: process.execArgv,
    nodeOptions: process.env.NODE_OPTIONS ?? "",
    nestPort: port,
    echoUrl: echo.url,
    enable: enableReport(),
    responses,
    received: echo.received,
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
