// One export in flight during an outage (architecture §4.9, "Outage bound"). The real
// BatchSpanProcessor (sdk-trace 3.1.1) drives a scripted exporter that stands where the
// OTLP exporter goes, so concurrency is counted exactly. Registers no OpenTelemetry global;
// sets OpenTelemetry's global error handler and restores it after each test.
import {
  type ExportResult,
  ExportResultCode,
  loggingErrorHandler,
  setGlobalErrorHandler,
} from "@opentelemetry/core";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createProcessorChain,
  type PipelineCounters,
} from "../src/otel/pipeline.js";
import { createRedactingExporter } from "../src/otel/redacting-exporter.js";
import { recordingDiagnostics } from "./otel-helpers.js";

const span = {
  name: "s",
  kind: 0,
  spanContext: () => ({
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    traceFlags: 1,
  }),
  attributes: {},
  status: { code: 0 },
  events: [],
  links: [],
  resource: { attributes: {} },
} as unknown as ReadableSpan;

type Mode = "hang" | "fail" | "ok";

/** An exporter whose behaviour is switched by the test, counting exports in flight. */
function scriptedExporter(initial: Mode, delayMs = 20) {
  const state = {
    mode: initial,
    delayMs,
    calls: 0,
    /** Span count of each call, in order. */
    sizes: [] as number[],
    failed: 0,
    inFlight: 0,
    maxInFlight: 0,
    /** Calls left hanging, oldest first. */
    hanging: [] as ((result: ExportResult) => void)[],
  };
  const exporter: SpanExporter = {
    export(spans, done) {
      state.calls++;
      state.sizes.push(spans.length);
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      const finish = (result: ExportResult) => {
        state.inFlight--;
        done(result);
      };
      if (state.mode === "hang") {
        state.hanging.push(finish);
        return;
      }
      const code =
        state.mode === "ok"
          ? ExportResultCode.SUCCESS
          : ExportResultCode.FAILED;
      setTimeout(() => {
        if (code === ExportResultCode.FAILED) state.failed++;
        finish({
          code,
          ...(code === ExportResultCode.FAILED
            ? { error: new Error("collector down") }
            : {}),
        });
      }, state.delayMs);
    },
    shutdown: () => Promise.resolve(),
  };
  return { state, exporter };
}

function counters(): PipelineCounters {
  return {
    droppedSpans: 0,
    exportedSpans: 0,
    exportFailedSpans: 0,
    redactDroppedSpans: 0,
    redactFailedSpans: 0,
  };
}

const QUEUE = {
  maxQueueSize: 64,
  maxExportBatchSize: 4,
  scheduledDelayMillis: 5,
};

/** Ends `perTick` spans every 2 ms for `ms` ms; resolves with how many were ended. */
async function load(
  processor: SpanProcessor,
  ms: number,
  perTick = 4,
): Promise<number> {
  let produced = 0;
  const timer = setInterval(() => {
    for (let i = 0; i < perTick; i++) {
      processor.onEnd(span);
      produced++;
    }
  }, 2);
  await new Promise((r) => setTimeout(r, ms));
  clearInterval(timer);
  return produced;
}

function chain(exporter: SpanExporter, exportTimeoutMillis = 10_000) {
  const c = counters();
  const d = recordingDiagnostics();
  const pipeline = createProcessorChain(exporter, {
    scrub: undefined,
    redact: undefined,
    queue: QUEUE,
    exportTimeoutMillis,
    counters: c,
    diagnostics: d,
  });
  return { pipeline, processor: pipeline.processor, c, d };
}

const errors: unknown[] = [];
setGlobalErrorHandler((error) => errors.push(error));
afterEach(() => {
  errors.length = 0;
  setGlobalErrorHandler((error) => errors.push(error));
});
afterAll(() => setGlobalErrorHandler(loggingErrorHandler()));

describe("SDK 3.1.1 BatchSpanProcessor without the wrapper", () => {
  it("overlaps exports once one has failed (the reason for the wrapper; fails if the SDK fixes it)", async () => {
    const { state, exporter } = scriptedExporter("fail");
    const batch = new BatchSpanProcessor({
      exporter,
      ...QUEUE,
      exportTimeoutMillis: 10_000,
    });
    await load(batch, 300);
    await new Promise((r) => setTimeout(r, 50));
    expect(state.maxInFlight).toBeGreaterThan(1);
  });
});

describe("processor chain: one export in flight", () => {
  it("a failing collector: one export at a time across many ticks, the queue holds and drops, the processor never sees a failure", async () => {
    const { state, exporter } = scriptedExporter("fail");
    const { processor, c, d } = chain(exporter);
    let produced = await load(processor, 300);
    expect(state.calls).toBeGreaterThanOrEqual(5);
    expect(state.maxInFlight).toBe(1);
    expect(c.droppedSpans).toBeGreaterThan(0);
    // Every failed batch reached the global error handler, as the SDK would have sent it.
    expect(errors.length).toBe(state.failed);
    expect(c.exportFailedSpans).toBeGreaterThan(0);
    // The processor kept its own flag, so the hard limit never had to refuse a batch.
    expect(d.logs.has("otel.export-busy")).toBe(false);

    // The collector recovers: later batches are exported.
    state.mode = "ok";
    await new Promise((r) => setTimeout(r, 40));
    const exportedBefore = c.exportedSpans;
    produced += await load(processor, 100);
    await processor.forceFlush();
    // forceFlush does not wait for a timer-driven export already in flight (SDK 3.1.1).
    await expect.poll(() => state.inFlight).toBe(0);
    expect(c.exportedSpans).toBeGreaterThan(exportedBefore);
    expect(c.exportedSpans + c.exportFailedSpans + c.droppedSpans).toBe(
      produced,
    );
    expect(d.failures).toEqual([]);
  });

  it("a hanging collector past the processor's export timeout: still one export, one batch waits, the rest are refused and counted; on recovery the waiting batch goes first", async () => {
    const { state, exporter } = scriptedExporter("hang");
    // The processor gives up on each export after 20 ms: its `_isExporting` flag is then
    // cleared while the exporter's request is still open, the case the hard limit covers.
    const { processor, c, d } = chain(exporter, 20);
    let produced = await load(processor, 300);
    expect(state.calls).toBe(1);
    expect(state.maxInFlight).toBe(1);
    expect(c.exportFailedSpans).toBeGreaterThan(0);
    expect(d.logs.has("otel.export-busy")).toBe(true);

    // Recovery: the hanging request is answered, the waiting batch starts at once. Answers
    // now come well inside the processor's 20 ms timeout.
    state.mode = "ok";
    state.delayMs = 2;
    state.hanging.shift()?.({ code: ExportResultCode.SUCCESS });
    expect(state.calls).toBe(2);
    produced += await load(processor, 100);
    expect(state.maxInFlight).toBe(1);
    await processor.forceFlush();
    // forceFlush does not wait for a timer-driven export already in flight (SDK 3.1.1).
    await expect.poll(() => state.inFlight).toBe(0);
    expect(c.exportedSpans).toBeGreaterThan(2 * QUEUE.maxExportBatchSize);
    expect(c.exportedSpans + c.exportFailedSpans + c.droppedSpans).toBe(
      produced,
    );
    expect(d.failures).toEqual([]);
  });
});

describe("processor chain: flush and shutdown are not limited", () => {
  it("shutdown exports every queued batch, concurrently, well within the bound", async () => {
    const { state, exporter } = scriptedExporter("ok", 30);
    const { processor, c } = chain(exporter);
    // The 4th span starts one export; the other 36 wait in the queue (9 batches).
    for (let i = 0; i < 40; i++) processor.onEnd(span);
    const started = Date.now();
    await processor.shutdown();
    const took = Date.now() - started;
    expect(c.exportedSpans).toBe(40);
    expect(state.maxInFlight).toBeGreaterThan(1);
    expect(took).toBeLessThan(500);
  });

  it("forceFlush during a hang: the waiting batch and the queue go out at once; only the hanging request is outstanding", async () => {
    const { state, exporter } = scriptedExporter("hang");
    const { processor, c } = chain(exporter, 20);
    for (let i = 0; i < 4; i++) processor.onEnd(span); // export 1, hangs
    await new Promise((r) => setTimeout(r, 40)); // processor timeout clears its flag
    for (let i = 0; i < 4; i++) processor.onEnd(span); // waits in the wrapper
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 3; i++) processor.onEnd(span); // below a batch: queued
    expect(state.calls).toBe(1);

    state.mode = "ok";
    state.delayMs = 2;
    await processor.forceFlush();
    expect(state.calls).toBe(3);
    expect(state.sizes).toEqual([4, 4, 3]);
    expect(c.exportedSpans).toBe(7);
    state.hanging.shift()?.({ code: ExportResultCode.SUCCESS });
    expect(c.exportedSpans).toBe(11);
    expect(c.exportFailedSpans + c.droppedSpans).toBe(0);
  });

  it("abort at the shutdown bound fails the in-flight, waiting and flushed batches, and counts each span once", async () => {
    const { state, exporter } = scriptedExporter("hang");
    const { pipeline, processor, c } = chain(exporter, 20);
    const produced = await load(processor, 150);
    const shutdown = processor.shutdown();
    await new Promise((r) => setTimeout(r, 30));
    pipeline.abort();
    await expect(shutdown).resolves.toBeUndefined();
    expect(c.exportedSpans).toBe(0);
    expect(c.exportFailedSpans + c.droppedSpans).toBe(produced);
    // A late answer to an aborted request changes nothing.
    for (const finish of state.hanging) {
      finish({ code: ExportResultCode.SUCCESS });
    }
    expect(c.exportedSpans).toBe(0);
    expect(c.exportFailedSpans + c.droppedSpans).toBe(produced);
  });
});

describe("one-in-flight limit (fault injection)", () => {
  function setup() {
    const calls: ((r: ExportResult) => void)[] = [];
    let throwNext = false;
    const inner: SpanExporter = {
      export(_spans, done) {
        if (throwNext) {
          throwNext = false;
          throw new Error("serializer");
        }
        calls.push(done);
      },
      shutdown: () => Promise.resolve(),
    };
    const c = counters();
    const d = recordingDiagnostics();
    const exporter = createRedactingExporter(inner, {
      scrub: undefined,
      redact: undefined,
      counters: c,
      diagnostics: d,
    });
    return {
      exporter,
      calls,
      c,
      d,
      throwOnNext: () => {
        throwNext = true;
      },
    };
  }

  it("a failure is counted and reported, the waiting batch starts, and an inner throw on it still answers once and frees the slot", () => {
    const { exporter, calls, c, d, throwOnNext } = setup();
    const got: ExportResult[][] = [[], [], [], []];
    exporter.export([span, span], (r) => got[0]?.push(r));
    exporter.export([span], (r) => got[1]?.push(r)); // waits
    exporter.export([span, span, span], (r) => got[2]?.push(r)); // refused
    expect(calls).toHaveLength(1);
    expect(got[2]?.map((r) => r.code)).toEqual([ExportResultCode.SUCCESS]);
    expect(c.exportFailedSpans).toBe(3);

    throwOnNext(); // the waiting batch's inner export throws
    calls[0]?.({ code: ExportResultCode.FAILED, error: new Error("down") });
    expect(got[0]?.map((r) => r.code)).toEqual([ExportResultCode.SUCCESS]);
    expect(got[1]?.map((r) => r.code)).toEqual([ExportResultCode.SUCCESS]);
    expect(c.exportFailedSpans).toBe(3 + 2 + 1);
    expect(errors).toHaveLength(1);
    expect(d.failures.map((f) => f.where)).toEqual(["otel.exporter.export"]);

    // Nothing is in flight now: the next export goes straight out.
    exporter.export([span], (r) => got[3]?.push(r));
    expect(calls).toHaveLength(2);
    calls[1]?.({ code: ExportResultCode.SUCCESS });
    expect(c.exportedSpans).toBe(1);
  });

  it("duringFlush restores the limit even when the flush throws", () => {
    const { exporter, calls } = setup();
    exporter.export([span], () => {});
    expect(() =>
      exporter.duringFlush(() => {
        exporter.export([span], () => {}); // not limited: starts
        throw new Error("flush");
      }),
    ).toThrow("flush");
    expect(calls).toHaveLength(2);
    exporter.export([span], () => {}); // limited again: waits
    expect(calls).toHaveLength(2);
    exporter.beginShutdown(); // the waiting batch starts
    expect(calls).toHaveLength(3);
    exporter.export([span], () => {}); // after shutdown began: not limited
    expect(calls).toHaveLength(4);
  });

  it("a throwing result callback does not leave the slot taken", () => {
    const { exporter, calls, d } = setup();
    exporter.export([span], () => {
      throw new Error("callback");
    });
    calls[0]?.({ code: ExportResultCode.SUCCESS });
    exporter.export([span], () => {});
    expect(calls).toHaveLength(2);
    expect(d.failures.map((f) => f.where)).toEqual(["otel.exporter.callback"]);
  });
});
