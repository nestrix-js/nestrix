// P3-02 acceptance: an app with @nestjs/schedule and @nestjs/config produces no spans at startup;
// a scheduled method gives one root span per tick, linked to the span active at call time (D-62); a
// BullMQ processor's `process` is a child of the active span when there is one, else a root.
import "reflect-metadata";
import { Processor } from "@nestjs/bullmq";
import { Controller, Get, Inject, Injectable, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Interval, ScheduleModule } from "@nestjs/schedule";
import { context, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { NestrixInstrument } from "../../src/methods/instrument.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import {
  BASE_OPTIONS,
  bootInstrumented,
  contextInstrumented,
  type Instrumented,
  methodSpans,
  recordingSink,
  resetSpans,
  setupTracing,
  spanNames,
  spans,
  waitFor,
} from "./helpers.js";

setupTracing();

@Injectable()
class ReportService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}
  build(): string {
    return `report:${this.config.get("REPORT_KIND", "daily")}`;
  }
}

@Injectable()
class TickService {
  static runs = 0;
  constructor(@Inject(ReportService) private readonly reports: ReportService) {}
  @Interval("p3-02-tick", 25)
  tick(): void {
    TickService.runs++;
    this.reports.build();
  }
}

@Controller("report")
class ReportController {
  constructor(@Inject(ReportService) private readonly reports: ReportService) {}
  @Get()
  get(): string {
    return this.reports.build();
  }
}

@Module({
  imports: [ConfigModule],
  controllers: [ReportController],
  providers: [ReportService, TickService],
})
class JobsModule {}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({ ignoreEnvFile: true }),
    JobsModule,
    NestrixModule.forRoot(BASE_OPTIONS),
  ],
})
class ScheduleApp {}

let booted: Instrumented | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

describe("@nestjs/schedule and @nestjs/config", () => {
  it("no spans at startup, then one root span per tick, linked to the span active at call time", async () => {
    TickService.runs = 0;
    resetSpans();
    // Started inside a span, as a bootstrap span in main.ts would be: the interval inherits it.
    const tracer = trace.getTracer("test");
    let bootstrapSpanId = "";
    booted = await tracer.startActiveSpan("bootstrap", async (span) => {
      bootstrapSpanId = span.spanContext().spanId;
      try {
        return await bootInstrumented(
          "express",
          ScheduleApp,
          NestrixInstrument,
        );
      } finally {
        span.end();
      }
    });
    const atStartup = spanNames().filter((n) => n !== "bootstrap");
    console.log(`spans at startup: ${JSON.stringify(atStartup)}`);
    expect(atStartup).toEqual([]);

    await waitFor(() => TickService.runs >= 3);
    const ticks = methodSpans().filter((s) => s.name === "TickService.tick");
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (const t of ticks) {
      expect(t.parentSpanContext).toBeUndefined();
      expect(t.attributes["nestrix.entry"]).toBe("scheduled");
      expect(t.links.map((l) => l.context.spanId)).toEqual([bootstrapSpanId]);
      // The service it calls is its child; ConfigService (from ConfigModule) is not traced.
      const child = methodSpans().find(
        (s) =>
          s.name === "ReportService.build" &&
          s.parentSpanContext?.spanId === t.spanContext().spanId,
      );
      expect(child).toBeDefined();
    }
    expect(new Set(ticks.map((t) => t.spanContext().traceId)).size).toBe(
      ticks.length,
    );
    expect(spans().some((s) => s.name.startsWith("ConfigService"))).toBe(false);
    expect(spans().some((s) => s.name.startsWith("Schedule"))).toBe(false);
  });

  it("a scheduled method called inside a request still starts its own root, linked to the request", async () => {
    booted = await bootInstrumented("express", ScheduleApp, NestrixInstrument);
    const tick = booted.app.get(TickService);
    resetSpans();
    const tracer = trace.getTracer("test");
    const parent = tracer.startSpan("request");
    context.with(trace.setSpan(context.active(), parent), () => tick.tick());
    parent.end();
    const direct = methodSpans().find(
      (s) =>
        s.name === "TickService.tick" &&
        s.links.some((l) => l.context.spanId === parent.spanContext().spanId),
    );
    expect(direct?.parentSpanContext).toBeUndefined();
    expect(direct?.spanContext().traceId).not.toBe(
      parent.spanContext().traceId,
    );
  });
});

@Processor("p3-02-queue")
class ReportProcessor {
  async process(job: { name: string }): Promise<string> {
    await Promise.resolve();
    return `done:${job.name}`;
  }
  onCompleted(): void {}
}

@Module({ providers: [ReportProcessor], exports: [ReportProcessor] })
class ProcessorModule {}

@Module({ imports: [ProcessorModule, NestrixModule.forRoot(BASE_OPTIONS)] })
class ProcessorApp {}

describe("BullMQ @Processor process (no Redis: called as the worker would)", () => {
  it("is a child of the active span (BullMQ's consumer span) when there is one, else a new root", async () => {
    const app = await contextInstrumented(ProcessorApp, NestrixInstrument);
    const { calls, dispose } = recordingSink();
    try {
      const processor = app.get(ReportProcessor);
      resetSpans();
      expect(await processor.process({ name: "a" })).toBe("done:a");
      const tracer = trace.getTracer("test");
      const consumer = tracer.startSpan("p3-02-queue process");
      const result = await context.with(
        trace.setSpan(context.active(), consumer),
        () => processor.process({ name: "b" }),
      );
      consumer.end();
      expect(result).toBe("done:b");
      const process = methodSpans().filter(
        (s) => s.name === "ReportProcessor.process",
      );
      expect(process).toHaveLength(2);
      expect(process[0]?.parentSpanContext).toBeUndefined();
      expect(process[1]?.parentSpanContext?.spanId).toBe(
        consumer.spanContext().spanId,
      );
      for (const s of process) {
        expect(s.attributes["nestrix.entry"]).toBe("job");
        expect(s.attributes["nestrix.component"]).toBe("processor");
      }
      // Other processor methods are ordinary method spans.
      processor.onCompleted();
      const completed = methodSpans().find(
        (s) => s.name === "ReportProcessor.onCompleted",
      );
      expect(completed?.attributes["nestrix.entry"]).toBeUndefined();
      expect(calls.filter((c) => c.kind === "processor")).toHaveLength(3);
    } finally {
      dispose();
      await app.close();
    }
  });
});
