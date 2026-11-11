// Global state: the host registered its own SDK 3 provider, with nestrixSpanProcessor()
// beside its exporter, before Nestrix. A real Express app with NestrixModule serves
// requests; the store receives Nestrix's spans and the host instrumentation's, redacted,
// while the host's own exporter gets them unredacted (Nestrix cannot redact what a host
// exports, architecture §4.8).
import "reflect-metadata";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { AppModule } from "express-esm/app.module";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NestrixModule } from "../src/nestrix.module.js";
import type { RedactableSpan } from "../src/options.js";
import { setupTelemetry } from "../src/otel/setup.js";
import { nestrixSpanProcessor } from "../src/store/span-processor.js";
import { getStore } from "../src/store/store.js";
import { config, recordingDiagnostics } from "./otel-helpers.js";

const hostExporter = new InMemorySpanExporter();
const hostProvider = new TracerProvider({
  spanProcessors: [
    new SimpleSpanProcessor({ exporter: hostExporter }),
    nestrixSpanProcessor(),
  ],
});
trace.setGlobalTracerProvider(hostProvider);
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

const diagnostics = recordingDiagnostics();
const redact = (span: RedactableSpan) => {
  if (span.name === "host.boom") throw new Error("user hook fault");
  return undefined;
};
const handle = setupTelemetry(
  config({
    dashboardStore: { maxTraces: 100, maxBytes: 4 * 1024 * 1024 },
    redact,
  }),
  diagnostics,
);

@Controller("h")
class HostController {
  @Get("ok")
  ok(): string {
    // The host's own instrumentation, on its own tracer.
    const span = trace
      .getTracer("@opentelemetry/instrumentation-http", "0.300.0")
      .startSpan("host.call", {
        attributes: {
          "url.full": "https://user:pw@api.example.com/v1?token=abc&q=1",
          "http.request.header.authorization": ["Bearer secret"],
        },
      });
    span.end();
    trace.getTracer("host-lib").startSpan("host.boom").end();
    return "ok";
  }
}

@Module({
  imports: [AppModule, NestrixModule.forRoot({ serviceName: "store-host" })],
  controllers: [HostController],
})
class TestModule {}

afterAll(async () => {
  await handle.shutdown();
});

describe("host-owned SDK 3 provider with nestrixSpanProcessor()", () => {
  it("fills the store with Nestrix's and the host's spans, redacted, and leaves the host's request alone", async () => {
    expect(handle.ownsProvider).toBe(false);
    const store = handle.store;
    expect(store).toBe(getStore());
    if (!store) throw new Error("no store");
    // The host already added the processor: no hint.
    expect(diagnostics.logs.has("store.host-processor-hint")).toBe(false);

    const app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as { port: number };
    const remoteTrace = "4bf92f3577b34da6a3ce929d0e0e4736";
    const remoteParent = "00f067aa0ba902b7";
    try {
      const res = await fetch(`http://127.0.0.1:${port}/h/ok`, {
        headers: { traceparent: `00-${remoteTrace}-${remoteParent}-01` },
      });
      // The redact hook threw inside the store's drain; the request is unaffected.
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      await vi.waitFor(() =>
        expect(store.listTraces({ limit: 10 }).items).toHaveLength(1),
      );

      // The incoming traceparent made the server span's parent remote: it is the local root.
      const [summary] = store.listTraces({ limit: 10 }).items;
      expect(summary).toMatchObject({
        traceId: remoteTrace,
        route: "/h/ok",
        statusCode: 200,
      });
      const stored = store.getTrace(remoteTrace);
      const server = stored?.spans.find((s) => s.kind === "server");
      expect(server?.parentSpanId).toBe(remoteParent);
      expect(stored?.rootSpanId).toBe(server?.spanId);

      const call = stored?.spans.find((s) => s.name === "host.call");
      expect(call?.scope).toBe("@opentelemetry/instrumentation-http");
      expect(call?.attributes["url.full"]).toBe(
        "https://REDACTED:REDACTED@api.example.com/v1?token=REDACTED&q=1",
      );
      expect(call?.attributes["http.request.header.authorization"]).toEqual([
        "REDACTED",
      ]);
      expect(stored?.spans.some((s) => s.name === "host.boom")).toBe(false);
      expect(store.stats()).toMatchObject({
        redactFailedSpans: 1,
        processors: 1,
      });

      // The host's exporter got everything, unredacted: the store's copy is separate.
      const hostCall = hostExporter
        .getFinishedSpans()
        .find((s) => s.name === "host.call");
      expect(hostCall?.attributes["url.full"]).toBe(
        "https://user:pw@api.example.com/v1?token=abc&q=1",
      );
      expect(
        hostExporter.getFinishedSpans().some((s) => s.name === "host.boom"),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("the host's forceFlush and shutdown resolve with the processor in place", async () => {
    await expect(hostProvider.forceFlush()).resolves.toBeUndefined();
    await expect(hostProvider.shutdown()).resolves.toBeUndefined();
  });
});
