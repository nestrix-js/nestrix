// P13-01 (D-78), global state: the host owns the SDK (an in-memory provider registered first), so
// `maxSpansPerTrace` limits only the spans Nestrix creates; the host's sampler decides the rest.
import "reflect-metadata";
import { Processor } from "@nestjs/bullmq";
import { Controller, Get, Inject, Injectable, Module } from "@nestjs/common";
import { context, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NestrixInstrument } from "../src/methods/instrument.js";
import { setMethodCallSink } from "../src/methods/sink.js";
import { NestrixModule } from "../src/nestrix.module.js";
import { withSpan } from "../src/span.js";
import { ClassStatistics } from "../src/stats/class-stats.js";
import {
  ATTR_SPANS_DROPPED,
  installedTraceSpanCounter,
  TraceSpanCounter,
} from "../src/trace-limit.js";
import {
  bootInstrumented,
  contextInstrumented,
  resetSpans,
  setupTracing,
  spans,
} from "./methods/helpers.js";

setupTracing();

afterEach(() => {
  vi.restoreAllMocks();
  resetSpans();
});

@Injectable()
class RowService {
  save(i: number): number {
    return i;
  }
}

@Processor("p13-rows-host")
class RowProcessor {
  constructor(@Inject(RowService) private readonly rows: RowService) {}
  async process(job: { count: number; hostSpans: number }): Promise<number> {
    const hostTracer = trace.getTracer("host-library");
    let sum = 0;
    for (let i = 0; i < job.count; i++) {
      sum += this.rows.save(i);
      if (i < job.hostSpans) hostTracer.startSpan("host.query").end();
      if (i % 50 === 0) await Promise.resolve();
    }
    return sum;
  }
}

@Controller("rows")
class RowController {
  constructor(@Inject(RowService) private readonly rows: RowService) {}
  @Get()
  list(): string {
    let sum = 0;
    for (let i = 0; i < 250; i++) sum += this.rows.save(i);
    return String(sum);
  }
}

function appModule(maxSpansPerTrace: number | false = 100) {
  @Module({
    imports: [
      NestrixModule.forRoot({
        export: { otlp: false },
        ui: false,
        metrics: false,
        maxSpansPerTrace,
      }),
    ],
    controllers: [RowController],
    providers: [RowService, RowProcessor],
  })
  class RowsApp {}
  return RowsApp;
}

const nestrixSpans = (traceId: string | undefined) =>
  spans().filter(
    (s) =>
      s.spanContext().traceId === traceId &&
      s.instrumentationScope.name === "@nestrix-js/nestjs",
  );

const SUM_250 = (249 * 250) / 2;

describe("host-owned SDK, maxSpansPerTrace: 100", () => {
  it("BullMQ-style job: only Nestrix's spans are limited; the job span carries the counts; class statistics count every call", async () => {
    const stats = new ClassStatistics();
    const removeSink = setMethodCallSink(stats);
    const app = await contextInstrumented(appModule(), NestrixInstrument);
    try {
      expect(installedTraceSpanCounter()?.mode).toBe("host");
      expect(
        await app.get(RowProcessor).process({ count: 250, hostSpans: 200 }),
      ).toBe(SUM_250);
    } finally {
      await app.close();
      removeSink();
    }
    expect(installedTraceSpanCounter()).toBeUndefined();
    const job = spans().find((s) => s.name === "RowProcessor.process");
    expect(job?.parentSpanContext).toBeUndefined();
    const traceId = job?.spanContext().traceId;
    expect(nestrixSpans(traceId)).toHaveLength(100);
    // The host's 200 spans are all there, every one parented on a recorded span.
    const host = spans().filter(
      (s) => s.spanContext().traceId === traceId && s.name === "host.query",
    );
    expect(host).toHaveLength(200);
    const ids = new Set(
      spans()
        .filter((s) => s.spanContext().traceId === traceId)
        .map((s) => s.spanContext().spanId),
    );
    for (const s of host) {
      expect(ids.has(s.parentSpanContext?.spanId ?? "")).toBe(true);
    }
    expect(
      Object.fromEntries(
        Object.entries(job?.attributes ?? {}).filter(([k]) =>
          k.startsWith(ATTR_SPANS_DROPPED),
        ),
      ),
    ).toEqual({
      [ATTR_SPANS_DROPPED]: 151,
      [`${ATTR_SPANS_DROPPED}.app`]: 151,
    });
    const save = stats
      .query(15, true)
      .classes.find((c) => c.className === "RowService")
      ?.methods.find((m) => m.method === "save");
    expect(save?.calls).toBe(250);
  });

  it("an HTTP request: Nestrix's server span is the root and carries the counts", async () => {
    const booted = await bootInstrumented(
      "fastify",
      appModule(),
      NestrixInstrument,
    );
    try {
      expect(await booted.get("/rows")).toEqual({
        status: 200,
        body: String(SUM_250),
      });
    } finally {
      await booted.close();
    }
    const server = spans().find((s) => s.attributes["url.path"] === "/rows");
    expect(nestrixSpans(server?.spanContext().traceId)).toHaveLength(100);
    expect(server?.attributes[ATTR_SPANS_DROPPED]).toBe(152);
  });

  it("withSpan past the limit runs the function once, under the last recorded span, without a span", async () => {
    const app = await contextInstrumented(appModule(), NestrixInstrument);
    try {
      const tracer = trace.getTracer("host-root");
      const root = tracer.startSpan("host-root");
      let calls = 0;
      let lastContext: { spanId: string; traceFlags: number } | undefined;
      await context.with(trace.setSpan(context.active(), root), async () => {
        withSpan("first", () => {
          // The first Nestrix span in the trace: the counts' root.
          for (let i = 0; i < 150; i++) {
            withSpan("inner", (span) => {
              calls++;
              lastContext = span.spanContext();
            });
          }
        });
      });
      root.end();
      expect(calls).toBe(150);
      const first = spans().find((s) => s.name === "first");
      // The stand-in carries the parent's context, sampled.
      expect(lastContext).toEqual(
        expect.objectContaining({
          spanId: first?.spanContext().spanId,
          traceFlags: 1,
        }),
      );
      expect(spans().filter((s) => s.name === "inner")).toHaveLength(99);
      expect(first?.attributes[ATTR_SPANS_DROPPED]).toBe(51);
      expect(spans().find((s) => s.name === "host-root")?.attributes).toEqual(
        {},
      );
    } finally {
      await app.close();
    }
  });

  it("inside a dropped withSpan the active span is the non-recording stand-in; writes on it do not touch the recorded parent", async () => {
    const app = await contextInstrumented(appModule(), NestrixInstrument);
    try {
      let activeIsStandIn = false;
      let recordingInside = true;
      withSpan("first", () => {
        for (let i = 0; i < 150; i++) {
          withSpan("inner", (standIn) => {
            const active = trace.getActiveSpan();
            if (i === 120) {
              activeIsStandIn = active === standIn;
              recordingInside = active?.isRecording() ?? true;
            }
            active?.setAttribute("child.only", i);
            active?.recordException(new Error("child only"));
            active?.setStatus({ code: 2, message: "child only" });
          });
        }
        // Back in the parent: it is active again.
        expect(trace.getActiveSpan()?.isRecording()).toBe(true);
      });
      const first = spans().find((s) => s.name === "first");
      expect(activeIsStandIn).toBe(true);
      expect(recordingInside).toBe(false);
      // Only the recorded inner spans (the first 98) could have written on their own span.
      expect(first?.attributes["child.only"]).toBeUndefined();
      expect(first?.events).toHaveLength(0);
      expect(first?.status.code).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("siblings under a host-created parent share one budget: 250 sequential withSpan, limit 100, 100 recorded", async () => {
    const app = await contextInstrumented(appModule(), NestrixInstrument);
    try {
      const root = trace.getTracer("host-root").startSpan("host-root");
      let calls = 0;
      await context.with(trace.setSpan(context.active(), root), async () => {
        for (let i = 0; i < 250; i++) withSpan("sibling", () => calls++);
      });
      root.end();
      expect(calls).toBe(250);
      expect(spans().filter((s) => s.name === "sibling")).toHaveLength(100);
      // The counts need a live Nestrix span to be written on; with strictly sequential siblings
      // there is none once the budget is spent, so no attribute appears (see P13-01 as built).
      const carried = spans()
        .map((s) => Number(s.attributes[ATTR_SPANS_DROPPED] ?? 0))
        .reduce((a, b) => a + b, 0);
      expect(carried).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("a host-created parent with an outer Nestrix span: the outer span carries the counts of its later siblings' budget", async () => {
    const app = await contextInstrumented(appModule(), NestrixInstrument);
    try {
      const root = trace.getTracer("host-root").startSpan("host-root");
      await context.with(trace.setSpan(context.active(), root), async () => {
        for (let i = 0; i < 60; i++) withSpan("early", () => i);
        withSpan("late-carrier", () => {
          for (let i = 0; i < 100; i++) withSpan("inner", () => i);
        });
      });
      root.end();
      // 60 + 1 carrier + 39 inner fit; 61 inner are dropped, written on the carrier.
      expect(spans().filter((s) => s.name === "early")).toHaveLength(60);
      expect(spans().filter((s) => s.name === "inner")).toHaveLength(39);
      const carrier = spans().find((s) => s.name === "late-carrier");
      expect(carrier?.attributes[ATTR_SPANS_DROPPED]).toBe(61);
    } finally {
      await app.close();
    }
  });

  it("maxSpansPerTrace: false installs nothing and records every Nestrix span", async () => {
    const app = await contextInstrumented(appModule(false), NestrixInstrument);
    try {
      expect(installedTraceSpanCounter()).toBeUndefined();
      await app.get(RowProcessor).process({ count: 250, hostSpans: 0 });
    } finally {
      await app.close();
    }
    const job = spans().find((s) => s.name === "RowProcessor.process");
    expect(nestrixSpans(job?.spanContext().traceId)).toHaveLength(251);
  });

  it("fault injection: a counter that throws everywhere changes nothing for the app", async () => {
    for (const method of [
      "hostAdmit",
      "hostStarted",
      "hostEnding",
      "dropDescendant",
    ] as const) {
      vi.spyOn(TraceSpanCounter.prototype, method).mockImplementation(() => {
        throw new Error(`injected ${method}`);
      });
    }
    const booted = await bootInstrumented(
      "express",
      appModule(),
      NestrixInstrument,
    );
    try {
      expect(await booted.get("/rows")).toEqual({
        status: 200,
        body: String(SUM_250),
      });
      expect(
        await booted.app
          .get(RowProcessor)
          .process({ count: 120, hostSpans: 0 }),
      ).toBe((119 * 120) / 2);
      expect(withSpan("w", () => 42)).toBe(42);
    } finally {
      await booted.close();
    }
    const server = spans().find((s) => s.attributes["url.path"] === "/rows");
    // Nothing could be counted, so nothing was dropped.
    expect(nestrixSpans(server?.spanContext().traceId)).toHaveLength(252);
  });
});
