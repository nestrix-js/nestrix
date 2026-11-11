// Phase 1 conformance suite, last row: `createMicroservice` and `createApplicationContext` apps.
// "Nestrix starts without an HTTP adapter and does nothing HTTP-related."
//
// Global state: none registered before Nestrix (each app owns, then releases, the provider), so
// this lives apart from conformance-http.test.ts. Runs once per Nest version, not per adapter.
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { Transport } from "@nestjs/microservices";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NestrixCore } from "../src/core.js";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import { HttpServerInstrumentation } from "../src/http/server.js";
import { NestrixModule } from "../src/nestrix.module.js";

@Module({ imports: [NestrixModule.forRoot({ export: { otlp: false } })] })
class Root {}

let routeHookBuilt: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetDiagnosticsForTests();
  routeHookBuilt = vi.spyOn(HttpServerInstrumentation.prototype, "routeHook");
});
afterEach(() => vi.restoreAllMocks());

const nestVersion = process.env.CONFORMANCE_NEST ?? "latest 12.x";

describe(`conformance, apps without an HTTP adapter (Nest ${nestVersion})`, () => {
  it("createApplicationContext app: Nestrix starts and installs nothing HTTP-related", async () => {
    const app = await NestFactory.createApplicationContext(Root, {
      logger: false,
    });
    expect(app.get(HttpAdapterHost).httpAdapter).toBeNull();
    expect(app.get(NestrixCore).telemetry?.ownsProvider).toBe(true);
    expect(routeHookBuilt).not.toHaveBeenCalled();
    expect([...getFailureCounts().keys()]).toEqual([]);
    await app.close();
  });

  it("createMicroservice app: Nestrix starts and installs nothing HTTP-related", async () => {
    const app = await NestFactory.createMicroservice(Root, {
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port: 0 },
      logger: false,
    });
    await app.init();
    expect(app.get(HttpAdapterHost).httpAdapter).toBeNull();
    expect(app.get(NestrixCore).telemetry?.ownsProvider).toBe(true);
    expect(routeHookBuilt).not.toHaveBeenCalled();
    expect([...getFailureCounts().keys()]).toEqual([]);
    await app.close();
  });
});
