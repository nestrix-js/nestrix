// Global state: no host SDK. Nestrix owns the provider with the dashboard on and export
// off (the default development setup), so the provider's only processor is the store's.
// A real Express app with NestrixModule (which joins the provider as a second instance)
// serves requests; its server spans, handler spans and an error reach the store.
import "reflect-metadata";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { trace } from "@opentelemetry/api";
import { AppModule } from "express-esm/app.module";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NestrixModule } from "../src/nestrix.module.js";
import type { RedactableSpan } from "../src/options.js";
import { setupTelemetry } from "../src/otel/setup.js";
import { getStore } from "../src/store/store.js";
import { config, recordingDiagnostics } from "./otel-helpers.js";

const diagnostics = recordingDiagnostics();
const redact = (span: RedactableSpan) => {
  if (span.name === "app.secret") return false;
  return undefined;
};
// As P2-06 will: set dashboardStore before the app's own setup runs.
const handle = setupTelemetry(
  config({
    serviceName: "store-owned",
    dashboardStore: { maxTraces: 100, maxBytes: 4 * 1024 * 1024 },
    redact,
  }),
  diagnostics,
);

@Controller("s")
class StoreController {
  @Get("ok")
  ok(): string {
    trace.getTracer("app").startSpan("app.work").end();
    trace.getTracer("app").startSpan("app.secret").end();
    return "ok";
  }

  @Get("boom")
  boom(): never {
    throw new Error("store boom");
  }
}

@Module({
  // `ui: false`: this app joins the provider only; the store is attached once, by `handle`
  // above, whatever NODE_ENV the test runs under (with the dashboard on, P2-06's wiring would
  // attach this app as well).
  imports: [
    AppModule,
    NestrixModule.forRoot({ serviceName: "store-owned", ui: false }),
  ],
  controllers: [StoreController],
})
class TestModule {}

afterAll(async () => {
  await handle.shutdown();
});

describe("Nestrix-owned pipeline on Express, export off", () => {
  it("fills the store with server spans, child spans and errors; redaction applies", async () => {
    expect(handle.ownsProvider).toBe(true);
    expect(handle.store).toBe(getStore());
    const store = handle.store;
    if (!store) throw new Error("no store");

    const app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as { port: number };
    try {
      expect(
        (await fetch(`http://127.0.0.1:${port}/s/ok?token=abc`)).status,
      ).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/s/boom`)).status).toBe(500);
      // Spans reach the store on the next drain, not in the request.
      await vi.waitFor(() =>
        expect(store.listTraces({ limit: 10 }).items).toHaveLength(2),
      );

      const list = store.listTraces({ limit: 10 });
      expect(
        list.items.map((t) => [t.method, t.route, t.statusCode, t.error]),
      ).toEqual([
        ["GET", "/s/boom", 500, true],
        ["GET", "/s/ok", 200, false],
      ]);
      const ok = store.getTrace(list.items[1]?.traceId ?? "");
      const names = ok?.spans.map((s) => s.name) ?? [];
      expect(names).toContain("app.work");
      expect(names).not.toContain("app.secret");
      expect(ok?.resource["service.name"]).toBe("store-owned");
      const server = ok?.spans.find((s) => s.kind === "server");
      expect(server?.attributes["url.query"]).toBe("token=REDACTED");
      // Every span of the trace hangs off the server span.
      const spanIds = new Set(ok?.spans.map((s) => s.spanId));
      for (const span of ok?.spans ?? []) {
        if (span !== server)
          expect(spanIds.has(span.parentSpanId ?? "")).toBe(true);
      }

      const errors = store.listErrors({ limit: 10 });
      expect(errors.items.length).toBeGreaterThanOrEqual(1);
      expect(errors.items.every((e) => e.route === "/s/boom")).toBe(true);
      expect(errors.items.some((e) => e.message === "store boom")).toBe(true);
      expect(store.stats()).toMatchObject({
        redactDroppedSpans: 1,
        attached: 1,
      });
    } finally {
      await app.close();
    }
    expect(diagnostics.failures).toEqual([]);
  });

  // That a detached store takes no spans is in store-unit.test.ts; here the provider is
  // gone after the last shutdown anyway.
  it("detaches on shutdown", async () => {
    const store = getStore();
    if (!store) throw new Error("no store");
    expect(store.stats().attached).toBe(1);
    await handle.shutdown();
    expect(store.stats().attached).toBe(0);
  });
});
