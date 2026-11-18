// Global state: no host SDK; Nestrix owns the provider. The local tail decision (issue #43, D-100)
// and the keep probability on local roots (issue #30), through setupTelemetry and a real receiver.
import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getExportStatus,
  resetExportStatusForTests,
} from "../src/export-status.js";
import { setupTelemetry } from "../src/otel/setup.js";
import type { TelemetryHandle } from "../src/otel/types.js";
import { ATTR_SAMPLING_PROBABILITY } from "../src/tail-sampling.js";
import {
  config,
  otlp,
  type Receiver,
  recordingDiagnostics,
  startReceiver,
} from "./otel-helpers.js";

let receiver: Receiver;
let handle: TelemetryHandle | undefined;
beforeAll(async () => {
  receiver = await startReceiver();
});
afterAll(async () => {
  await receiver.close();
});
afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
  receiver.spans.length = 0;
  resetExportStatusForTests();
});

const QUEUE = {
  maxQueueSize: 20_000,
  maxExportBatchSize: 512,
  scheduledDelayMillis: 10,
};

function setup(overrides: Parameters<typeof config>[0] = {}) {
  const diagnostics = recordingDiagnostics();
  handle = setupTelemetry(
    config({
      export: { otlp: otlp(receiver.url), queue: QUEUE },
      ...overrides,
    }),
    diagnostics,
  );
  expect(handle.ownsProvider).toBe(true);
  return diagnostics;
}

const tracer = () => trace.getTracer("tail-test");

/** A root with `children` child spans; `fail` sets error status on the given span. */
function runTrace(
  name: string,
  options: {
    children?: number;
    failRoot?: boolean;
    failChild?: boolean;
    expectedChild?: boolean;
    durationMs?: number;
  } = {},
): string {
  const t = tracer();
  const start = Date.now();
  const root = t.startSpan(name, { startTime: start });
  const ctx = trace.setSpan(ROOT_CONTEXT, root);
  for (let i = 0; i < (options.children ?? 0); i++) {
    const child = t.startSpan(`${name}.child`, {}, ctx);
    if (i === 0 && options.failChild) {
      child.setStatus({ code: SpanStatusCode.ERROR });
      if (options.expectedChild) {
        child.addEvent("exception", {
          "exception.type": "NotFoundException",
          "nestrix.exception.expected": true,
        });
      }
    }
    child.end();
  }
  if (options.failRoot) root.setStatus({ code: SpanStatusCode.ERROR });
  root.end(start + (options.durationMs ?? 1));
  return root.spanContext().traceId;
}

describe("tail decision at sampleRate 0 (only the rules keep)", () => {
  it("exports a failed trace in full with probability 1, and drops an ok one", async () => {
    setup({ sampleRate: 0 });
    const ok = runTrace("ok", { children: 3 });
    const failedRoot = runTrace("failed-root", { children: 3, failRoot: true });
    const failedChild = runTrace("failed-child", {
      children: 3,
      failChild: true,
    });
    const expected = runTrace("expected-child", {
      children: 3,
      failChild: true,
      expectedChild: true,
    });
    await handle?.forceFlush();
    await receiver.waitForSpans(8);
    const byTrace = (id: string) =>
      receiver.spans.filter((s) => s.traceId === id);
    expect(byTrace(ok)).toHaveLength(0);
    expect(byTrace(expected)).toHaveLength(0);
    for (const id of [failedRoot, failedChild]) {
      const spans = byTrace(id);
      expect(spans).toHaveLength(4);
      const root = spans.find((s) => s.parentSpanId === undefined);
      expect(root?.attributes[ATTR_SAMPLING_PROBABILITY]).toBe(1);
      // Children carry no probability, and point at the exported root.
      for (const c of spans.filter((s) => s !== root)) {
        expect(c.parentSpanId).toBe(root?.spanId);
        expect(c.attributes[ATTR_SAMPLING_PROBABILITY]).toBeUndefined();
      }
    }
  });

  it("keeps a trace slower than keepSlowerThanMs, not one at or under it", async () => {
    setup({
      sampleRate: 0,
      sampling: { keepErrors: true, keepSlowerThanMs: 100 },
    });
    const slow = runTrace("slow", { children: 1, durationMs: 150 });
    const fast = runTrace("fast", { children: 1, durationMs: 100 });
    await handle?.forceFlush();
    await receiver.waitForSpans(2);
    expect(receiver.spans.filter((s) => s.traceId === fast)).toHaveLength(0);
    const kept = receiver.spans.filter((s) => s.traceId === slow);
    expect(kept.map((s) => s.name).sort()).toEqual(["slow", "slow.child"]);
    expect(
      kept.find((s) => s.name === "slow")?.attributes[
        ATTR_SAMPLING_PROBABILITY
      ],
    ).toBe(1);
  });

  it("keepErrors: false and no threshold is plain head sampling: nothing is recorded", async () => {
    setup({
      sampleRate: 0,
      sampling: { keepErrors: false, keepSlowerThanMs: false },
    });
    const span = tracer().startSpan("root");
    expect(span.isRecording()).toBe(false);
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    await handle?.forceFlush();
    expect(receiver.spans).toHaveLength(0);
  });

  it("sends traceparent -00 from an undecided trace, so downstream keeps the head decision", () => {
    setup({ sampleRate: 0 });
    const root = tracer().startSpan("root");
    expect(root.isRecording()).toBe(true);
    const headers: Record<string, string> = {};
    propagation.inject(trace.setSpan(ROOT_CONTEXT, root), headers);
    expect(headers.traceparent).toMatch(/-00$/);
    root.end();
  });

  it("does not record under an unsampled remote parent, even when it fails (D-100)", async () => {
    setup({ sampleRate: 0 });
    const upstream = propagation.extract(ROOT_CONTEXT, {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
    });
    const span = tracer().startSpan("server", {}, upstream);
    expect(span.isRecording()).toBe(false);
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    await handle?.forceFlush();
    expect(receiver.spans).toHaveLength(0);
  });

  it("records a child that starts after a kept root ended, and drops one after a dropped root", async () => {
    setup({ sampleRate: 0 });
    const t = tracer();
    const kept = t.startSpan("kept");
    kept.setStatus({ code: SpanStatusCode.ERROR });
    const keptCtx = trace.setSpan(ROOT_CONTEXT, kept);
    kept.end();
    const late = t.startSpan("kept.late", {}, keptCtx);
    expect(late.isRecording()).toBe(true);
    late.end();
    const dropped = t.startSpan("dropped");
    const droppedCtx = trace.setSpan(ROOT_CONTEXT, dropped);
    dropped.end();
    const late2 = t.startSpan("dropped.late", {}, droppedCtx);
    expect(late2.isRecording()).toBe(false);
    late2.end();
    await handle?.forceFlush();
    await receiver.waitForSpans(2);
    expect(receiver.spans.map((s) => s.name).sort()).toEqual([
      "kept",
      "kept.late",
    ]);
  });
});

describe("keep probability on local roots (issue #30)", () => {
  it("is the rate on a ratio-sampled ok root, 1 on a failed one, and absent under a remote parent", async () => {
    setup({ sampleRate: 1 });
    runTrace("ok", { children: 1 });
    runTrace("failed", { failRoot: true });
    const upstream = propagation.extract(ROOT_CONTEXT, {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });
    tracer().startSpan("remote-child", {}, upstream).end();
    await handle?.forceFlush();
    await receiver.waitForSpans(4);
    const attr = (name: string) =>
      receiver.spans.find((s) => s.name === name)?.attributes[
        ATTR_SAMPLING_PROBABILITY
      ];
    expect(attr("ok")).toBe(1);
    expect(attr("ok.child")).toBeUndefined();
    expect(attr("failed")).toBe(1);
    expect(attr("remote-child")).toBeUndefined();
  });

  it("is the ratio on roots the ratio kept, and 1 on failed ones whichever way they were kept", async () => {
    setup({ sampleRate: 0.5 });
    const okIds: string[] = [];
    const failedIds: string[] = [];
    for (let i = 0; i < 200; i++) okIds.push(runTrace("ok"));
    for (let i = 0; i < 50; i++)
      failedIds.push(runTrace("failed", { failRoot: true }));
    for (let i = 0; i < 50; i++)
      runTrace("child-failed", { children: 1, failChild: true });
    await handle?.forceFlush();
    await receiver.waitForSpans(200);
    const okSpans = receiver.spans.filter((s) => s.name === "ok");
    const failedSpans = receiver.spans.filter((s) => s.name === "failed");
    expect(failedSpans).toHaveLength(50);
    for (const s of failedSpans) {
      expect(s.attributes[ATTR_SAMPLING_PROBABILITY]).toBe(1);
    }
    // Binomial(200, 0.5): mean 100, sd about 7.1; the bound is more than 7 sd.
    expect(okSpans.length).toBeGreaterThan(50);
    expect(okSpans.length).toBeLessThan(150);
    for (const s of okSpans) {
      expect(s.attributes[ATTR_SAMPLING_PROBABILITY]).toBe(0.5);
    }
    // A failed child makes its root's probability 1 whether the ratio sampled the trace or not.
    const childFailedRoots = receiver.spans.filter(
      (s) => s.name === "child-failed",
    );
    expect(childFailedRoots).toHaveLength(50);
    for (const s of childFailedRoots) {
      expect(s.attributes[ATTR_SAMPLING_PROBABILITY]).toBe(1);
    }
  });
});

describe("memory bound", () => {
  it("evicts the oldest undecided trace past 10,000 held spans, and counts the drops", async () => {
    resetExportStatusForTests();
    const diagnostics = setup({ sampleRate: 0, maxSpansPerTrace: false });
    const t = tracer();
    const a = t.startSpan("a");
    const aCtx = trace.setSpan(ROOT_CONTEXT, a);
    for (let i = 0; i < 6_000; i++) t.startSpan("a.child", {}, aCtx).end();
    const b = t.startSpan("b");
    const bCtx = trace.setSpan(ROOT_CONTEXT, b);
    for (let i = 0; i < 5_000; i++) t.startSpan("b.child", {}, bCtx).end();
    // `a` was evicted when `b` reached the bound: its later spans are not even recorded.
    expect(t.startSpan("a.late", {}, aCtx).isRecording()).toBe(false);
    a.setStatus({ code: SpanStatusCode.ERROR });
    a.end();
    b.setStatus({ code: SpanStatusCode.ERROR });
    b.end();
    await handle?.forceFlush();
    await receiver.waitForSpans(5_001, 10_000);
    expect(receiver.spans.filter((s) => s.name.startsWith("a"))).toHaveLength(
      0,
    );
    expect(receiver.spans.filter((s) => s.name.startsWith("b"))).toHaveLength(
      5_001,
    );
    // 6,000 held children of `a`, and its root when it ended.
    expect(handle?.counters.tailDroppedSpans).toBe(6_001);
    expect(getExportStatus().traces.dropped).toBe(6_001);
    expect(diagnostics.failures).toEqual([]);
  });

  it("holds at most maxSpansPerTrace spans of one trace", async () => {
    setup({ sampleRate: 0, maxSpansPerTrace: 100 });
    runTrace("big", { children: 150, failRoot: true });
    await handle?.forceFlush();
    await receiver.waitForSpans(100);
    await new Promise((r) => setTimeout(r, 50));
    expect(receiver.spans).toHaveLength(100);
    const root = receiver.spans.find((s) => s.name === "big");
    expect(root?.attributes["nestrix.trace.spans_dropped"]).toBe(51);
    expect(root?.attributes[ATTR_SAMPLING_PROBABILITY]).toBe(1);
  });
});

describe("embedded store", () => {
  it("stores tail-kept traces once and nothing of dropped ones", async () => {
    const diagnostics = recordingDiagnostics();
    handle = setupTelemetry(
      config({
        sampleRate: 0,
        dashboardStore: { maxTraces: 100, maxBytes: 10_000_000 },
      }),
      diagnostics,
    );
    runTrace("ok", { children: 2 });
    runTrace("failed", { children: 2, failRoot: true });
    await new Promise((r) => setImmediate(r));
    handle.store?.drainNow();
    const stats = handle.store?.stats();
    expect(stats?.traces).toBe(1);
    expect(stats?.spans).toBe(3);
    expect(stats?.receivedSpans).toBe(3);
    expect(diagnostics.failures).toEqual([]);
  });
});

describe("faults never reach the code that ends a span (rule 1)", () => {
  it("a throwing tail registry is counted, the span is ended, and nothing throws", async () => {
    const { TailRegistry } = await import("../src/tail-sampling.js");
    const diagnostics = setup({ sampleRate: 0 });
    const boom = () => {
      throw new Error("injected");
    };
    const methods = [
      "rootStarted",
      "hasFailed",
      "childEnded",
      "rootEnded",
      "isRecording",
      "setRootDecision",
    ] as const;
    const saved = methods.map((m) => [m, TailRegistry.prototype[m]] as const);
    try {
      for (const m of methods) {
        (TailRegistry.prototype as unknown as Record<string, unknown>)[m] =
          boom;
      }
      expect(() =>
        context.with(ROOT_CONTEXT, () =>
          runTrace("faulty", { children: 2, failRoot: true }),
        ),
      ).not.toThrow();
    } finally {
      for (const [m, fn] of saved) {
        (TailRegistry.prototype as unknown as Record<string, unknown>)[m] = fn;
      }
    }
    const where = new Set(diagnostics.failures.map((f) => f.where));
    expect(where.has("tail-sampling.onStart")).toBe(true);
    expect(where.has("tail-sampling.onEnd")).toBe(true);
    expect(where.has("tail-sampling.sampler")).toBe(true);
  });
});
