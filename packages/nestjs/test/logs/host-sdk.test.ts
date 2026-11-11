// Global state: a host tracer provider is registered before Nestrix starts, so the host's SDK owns
// every signal (D-69): `logs.export: true` registers no LoggerProvider and says why once.
import "reflect-metadata";
import { Logger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { logs, trace } from "@opentelemetry/api";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resetDiagnosticsForTests } from "../../src/diagnostics.js";
import { getLogSink } from "../../src/logs/sink.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import { type LogReceiver, startLogReceiver } from "./helpers.js";

let receiver: LogReceiver;
beforeAll(async () => {
  trace.setGlobalTracerProvider(new TracerProvider());
  receiver = await startLogReceiver();
});
afterAll(async () => {
  await receiver.close();
  trace.disable();
});

describe("logs.export with a host-owned SDK", () => {
  it("registers no LoggerProvider, exports nothing, and logs once why", async () => {
    resetDiagnosticsForTests();
    const lines: string[] = [];
    const spy = vi
      .spyOn(Logger.prototype, "log")
      .mockImplementation((message: unknown) => {
        lines.push(String(message));
      });
    @Module({
      imports: [
        NestrixModule.forRoot({
          ui: false,
          logs: { export: true },
          export: { otlp: { endpoint: receiver.baseUrl, timeoutMillis: 1000 } },
        }),
      ],
    })
    class TestModule {}
    const before = logs.getLoggerProvider();
    try {
      const app = await NestFactory.create(TestModule, { logger: false });
      await app.init();
      await new Promise((r) => setTimeout(r, 200));
      new Logger("Outside").log("after init");
      expect(logs.getLoggerProvider()).toBe(before);
      expect(getLogSink()).toBeUndefined();
      await app.close();
    } finally {
      spy.mockRestore();
    }
    expect(
      lines.filter((l) => l.includes("registers no LoggerProvider")),
    ).toHaveLength(1);
    expect(receiver.logs).toEqual([]);
  });
});
