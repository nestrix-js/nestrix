// Global state: no host SDK; a Nest app whose provider constructor calls setupTelemetry,
// as NestrixCore will. Proves registration at provider construction works on the
// Nestrix-owned path and that onApplicationShutdown flushes.
import "reflect-metadata";
import {
  Controller,
  Get,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { trace } from "@opentelemetry/api";
import { AppModule } from "express-esm/app.module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTelemetry } from "../src/otel/setup.js";
import type { TelemetryHandle } from "../src/otel/types.js";
import {
  config,
  otlp,
  type Receiver,
  recordingDiagnostics,
  startReceiver,
} from "./otel-helpers.js";

let receiver: Receiver;
const diagnostics = recordingDiagnostics();
const construction: { recordingBefore?: boolean; recordingAfter?: boolean } =
  {};

@Injectable()
class TelemetryCore implements OnApplicationShutdown {
  readonly handle: TelemetryHandle;
  constructor() {
    construction.recordingBefore = trace
      .getTracer("probe")
      .startSpan("p")
      .isRecording();
    this.handle = setupTelemetry(
      config({
        serviceName: "otel-nest",
        export: {
          otlp: otlp(receiver.url),
          // Long delay: spans stay queued until shutdown flushes them.
          queue: {
            maxQueueSize: 100,
            maxExportBatchSize: 50,
            scheduledDelayMillis: 60_000,
          },
        },
      }),
      diagnostics,
    );
    construction.recordingAfter = trace
      .getTracer("probe")
      .startSpan("p")
      .isRecording();
  }
  onApplicationShutdown(): Promise<void> {
    return this.handle.shutdown();
  }
}

@Controller()
class WorkController {
  @Get("work")
  async work(): Promise<string> {
    // Tracer taken at use time, as Nestrix's instrumentation does.
    return trace.getTracer("app").startActiveSpan("work", async (span) => {
      await new Promise((r) => setTimeout(r, 2));
      trace.getTracer("app").startSpan("work.child").end();
      span.end();
      return "ok";
    });
  }
}

@Module({
  imports: [AppModule],
  controllers: [WorkController],
  providers: [TelemetryCore],
})
class TestModule {}

beforeAll(async () => {
  receiver = await startReceiver();
});
afterAll(async () => {
  await receiver.close();
});

describe("setupTelemetry from a provider constructor (express-esm fixture)", () => {
  it("registers during NestFactory.create, serves, and flushes on app.close()", async () => {
    const app = await NestFactory.create(TestModule, { logger: false });
    expect(construction).toEqual({
      recordingBefore: false,
      recordingAfter: true,
    });
    const core = app.get(TelemetryCore);
    expect(core.handle.ownsProvider).toBe(true);
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as { port: number };

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/work`);
      expect(await res.text()).toBe("ok");
    }
    const hello = await fetch(`http://127.0.0.1:${port}/hello`);
    expect(hello.status).toBe(200);
    // Still queued: nothing sent before shutdown.
    expect(receiver.posts).toBe(0);

    await app.close();
    const work = receiver.spans.filter((s) => s.name === "work");
    const children = receiver.spans.filter((s) => s.name === "work.child");
    expect(work).toHaveLength(3);
    expect(children).toHaveLength(3);
    for (const child of children) {
      expect(work.map((w) => w.spanId)).toContain(child.parentSpanId);
    }
    expect(work[0]?.resource["service.name"]).toBe("otel-nest");
    expect(diagnostics.failures).toEqual([]);
  });
});
