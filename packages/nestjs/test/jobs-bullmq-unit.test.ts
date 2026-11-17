// bullmqTelemetry() (issue #20, D-81): BullMQ's Telemetry interface on Nestrix's copy of the
// OpenTelemetry API, with the tracer resolved on use. The end-to-end check under plain node, with a
// real BullMQ and Redis, is test/e2e-phase3/jobs-node-esm.test.ts.
//
// Global state: each test registers (and removes) its own provider, context manager and
// propagator; this file runs in its own worker.
import { createRequire } from "node:module";
import {
  type Context,
  context,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import type { Telemetry } from "bullmq";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import { bullmqTelemetry } from "../src/index.js";

const require = createRequire(import.meta.url);
// The CommonJS build of the API: what a CommonJS package (bullmq-otel, a CommonJS host SDK) loads.
const cjsApi =
  require("@opentelemetry/api") as typeof import("@opentelemetry/api");

// The helper is assignable to BullMQ's own Telemetry type (checked by `pnpm typecheck`).
const typed: Telemetry = bullmqTelemetry();
void typed;

let exporter: InMemorySpanExporter;
let provider: TracerProvider;

function newProvider(): TracerProvider {
  exporter = new InMemorySpanExporter();
  provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  return provider;
}

const finished = (): ReadableSpan[] => exporter.getFinishedSpans();

beforeEach(() => {
  resetDiagnosticsForTests();
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

afterEach(async () => {
  trace.disable();
  cjsApi.trace.disable();
  context.disable();
  propagation.disable();
  metrics.disable();
  await provider?.shutdown();
});

describe("bullmqTelemetry: the tracer is resolved on use", () => {
  it("records spans when it was created before the provider was registered", () => {
    const telemetry = bullmqTelemetry({
      tracerName: "my-app",
      version: "1.2.3",
    });
    trace.setGlobalTracerProvider(newProvider());

    telemetry.tracer
      .startSpan("add emails.welcome", { kind: SpanKind.PRODUCER })
      .end();

    const [span] = finished();
    expect(span?.name).toBe("add emails.welcome");
    expect(span?.kind).toBe(SpanKind.PRODUCER);
    expect(span?.instrumentationScope).toMatchObject({
      name: "my-app",
      version: "1.2.3",
    });
  });

  it("records spans when the provider was registered through the CommonJS copy of the API after it was created", () => {
    // The issue #20 shape: two API copies share the globals but not their fallback proxy. A
    // tracer taken from this copy before registration stays a no-op for good (the control below),
    // which is what `new BullMQOtel()` at import time does on its CommonJS copy.
    expect(cjsApi.trace).not.toBe(trace);
    const telemetry = bullmqTelemetry();
    const eager = trace.getTracer("eager");
    cjsApi.trace.setGlobalTracerProvider(newProvider());

    const control = eager.startSpan("eager");
    expect(control.isRecording()).toBe(false);
    control.end();

    telemetry.tracer
      .startSpan("process emails", { kind: SpanKind.CONSUMER })
      .end();
    expect(
      finished().map((s) => [s.name, s.kind, s.instrumentationScope.name]),
    ).toEqual([["process emails", SpanKind.CONSUMER, "bullmq"]]);
  });

  it("follows a new provider after the old one is removed", () => {
    const telemetry = bullmqTelemetry();
    trace.setGlobalTracerProvider(newProvider());
    telemetry.tracer.startSpan("first", { kind: SpanKind.PRODUCER }).end();
    const first = exporter;
    trace.disable();
    trace.setGlobalTracerProvider(newProvider());
    telemetry.tracer.startSpan("second", { kind: SpanKind.PRODUCER }).end();
    expect(first.getFinishedSpans().map((s) => s.name)).toEqual(["first"]);
    expect(finished().map((s) => s.name)).toEqual(["second"]);
  });
});

describe("bullmqTelemetry: spans", () => {
  beforeEach(() => {
    trace.setGlobalTracerProvider(newProvider());
  });

  it("passes span kinds through and falls back to INTERNAL for an unknown kind", () => {
    const t = bullmqTelemetry({ rootSpans: true });
    for (const kind of [0, 1, 2, 3, 4, 99, Number.NaN]) {
      t.tracer.startSpan(`k${kind}`, { kind }).end();
    }
    t.tracer.startSpan("none").end();
    expect(finished().map((s) => s.kind)).toEqual([0, 1, 2, 3, 4, 0, 0, 0]);
  });

  it("parents a span on the context it is given, and setSpanOnContext makes it the parent of the next", () => {
    const t = bullmqTelemetry();
    const producer = t.tracer.startSpan(
      "add q.job",
      { kind: SpanKind.PRODUCER },
      ROOT_CONTEXT,
    );
    const ctx = producer.setSpanOnContext(ROOT_CONTEXT);
    const child = t.tracer.startSpan(
      "complete q",
      { kind: SpanKind.INTERNAL },
      ctx,
    );
    child.end();
    producer.end();
    const [c, p] = finished();
    expect(c?.parentSpanContext?.spanId).toBe(p?.spanContext().spanId);
    expect(c?.spanContext().traceId).toBe(p?.spanContext().traceId);
  });

  it("drops internal spans with no parent unless rootSpans is set; producer and consumer roots stay", () => {
    const t = bullmqTelemetry();
    const stalled = t.tracer.startSpan("moveStalledJobsToWait q", {
      kind: SpanKind.INTERNAL,
    });
    // A dropped span leaves the context as it was.
    expect(stalled.setSpanOnContext(ROOT_CONTEXT)).toBe(ROOT_CONTEXT);
    stalled.setAttributes({ a: 1 });
    stalled.addEvent("job stalled");
    stalled.recordException(new Error("x"));
    stalled.end();
    t.tracer.startSpan("add q.job", { kind: SpanKind.PRODUCER }).end();
    t.tracer.startSpan("process q", { kind: SpanKind.CONSUMER }).end();
    expect(finished().map((s) => s.name)).toEqual(["add q.job", "process q"]);

    exporter.reset();
    const kept = bullmqTelemetry({ rootSpans: true });
    kept.tracer
      .startSpan("moveStalledJobsToWait q", { kind: SpanKind.INTERNAL })
      .end();
    expect(finished().map((s) => s.name)).toEqual(["moveStalledJobsToWait q"]);
  });

  it("keeps an internal span that has a parent, from the argument or the active context", () => {
    const t = bullmqTelemetry();
    const parent = trace.getTracer("t").startSpan("parent");
    const ctx = trace.setSpan(ROOT_CONTEXT, parent);
    t.tracer.startSpan("pause q", { kind: SpanKind.INTERNAL }, ctx).end();
    context.with(ctx, () =>
      t.tracer.startSpan("drain q", { kind: SpanKind.INTERNAL }).end(),
    );
    parent.end();
    expect(finished().map((s) => s.name)).toEqual([
      "pause q",
      "drain q",
      "parent",
    ]);
  });

  it("marks the span failed on BullMQ's 'job failed' event: an exception with the reason and error status", () => {
    const t = bullmqTelemetry();
    const span = t.tracer.startSpan("process q", { kind: SpanKind.CONSUMER });
    span.addEvent("job failed", { "bullmq.job.failed.reason": "boom" });
    span.end();
    const [s] = finished();
    expect(s?.status.code).toBe(SpanStatusCode.ERROR);
    expect(s?.events.map((e) => [e.name, e.attributes])).toEqual([
      ["job failed", { "bullmq.job.failed.reason": "boom" }],
      ["exception", { "exception.message": "boom" }],
    ]);
  });

  it("sets error status on recordException, and records the exception as given", () => {
    const t = bullmqTelemetry();
    const span = t.tracer.startSpan("add q.job", { kind: SpanKind.PRODUCER });
    span.recordException(
      Object.assign(new Error("redis down"), { name: "ReplyError" }),
    );
    span.end();
    const [s] = finished();
    expect(s?.status.code).toBe(SpanStatusCode.ERROR);
    expect(s?.events[0]?.attributes).toMatchObject({
      "exception.type": "ReplyError",
      "exception.message": "redis down",
    });
  });

  it("never records the job's return value from the 'job completed' event", () => {
    const t = bullmqTelemetry();
    const span = t.tracer.startSpan("process q", { kind: SpanKind.CONSUMER });
    span.addEvent("job completed", {
      "bullmq.job.result": '{"secret":"value"}',
    });
    span.setAttributes({ "bullmq.job.id": "1", "bullmq.job.name": "email" });
    span.setAttribute("bullmq.job.attempts.made", 1);
    span.end();
    const [s] = finished();
    expect(s?.status.code).toBe(SpanStatusCode.UNSET);
    expect(s?.events.map((e) => [e.name, e.attributes])).toEqual([
      ["job completed", {}],
    ]);
    expect(s?.attributes).toEqual({
      "bullmq.job.id": "1",
      "bullmq.job.name": "email",
      "bullmq.job.attempts.made": 1,
    });
  });
});

describe("bullmqTelemetry: context manager and propagation", () => {
  beforeEach(() => {
    trace.setGlobalTracerProvider(newProvider());
  });

  it("carries the context in the job's metadata and back, so the consumer is the producer's child", () => {
    const t = bullmqTelemetry();
    const producer = t.tracer.startSpan("add q.job", {
      kind: SpanKind.PRODUCER,
    });
    const metadata = t.contextManager.getMetadata(
      producer.setSpanOnContext(ROOT_CONTEXT),
    );
    expect(JSON.parse(metadata)).toEqual({
      traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/),
    });
    producer.end();

    const parent = t.contextManager.fromMetadata(
      t.contextManager.active(),
      metadata,
    );
    const consumer = t.tracer.startSpan(
      "process q",
      { kind: SpanKind.CONSUMER },
      parent,
    );
    consumer.end();
    const [p, c] = finished();
    expect(c?.parentSpanContext?.spanId).toBe(p?.spanContext().spanId);
    expect(c?.parentSpanContext?.isRemote).toBe(true);
    expect(c?.spanContext().traceId).toBe(p?.spanContext().traceId);
  });

  it("gives the active context for metadata that is not a JSON object, without throwing", () => {
    const t = bullmqTelemetry();
    const active = t.contextManager.active();
    for (const bad of ["", "not json", "[1]", "null", "42", '"s"']) {
      expect(t.contextManager.fromMetadata(active, bad)).toBe(active);
    }
    expect(t.contextManager.fromMetadata(active, "{}")).toBeDefined();
  });

  it("runs fn once in the given context and returns its value; fn's own error is rethrown", () => {
    const t = bullmqTelemetry();
    const span = trace.getTracer("t").startSpan("s");
    const ctx = trace.setSpan(ROOT_CONTEXT, span);
    let calls = 0;
    const value = t.contextManager.with(ctx, () => {
      calls++;
      return trace.getSpan(t.contextManager.active());
    });
    expect(calls).toBe(1);
    expect(value).toBe(span);
    const boom = new Error("host error");
    calls = 0;
    expect(() =>
      t.contextManager.with(ctx, () => {
        calls++;
        throw boom;
      }),
    ).toThrow(boom);
    expect(calls).toBe(1);
    expect([...getFailureCounts().keys()]).toEqual([]);
    span.end();
  });

  it("root() is the empty context, detached from the active span", () => {
    const t = bullmqTelemetry();
    const span = trace.getTracer("t").startSpan("s");
    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      expect(trace.getSpan(t.contextManager.root())).toBeUndefined();
      expect(t.contextManager.root()).toBe(ROOT_CONTEXT);
    });
    span.end();
  });
});

describe("bullmqTelemetry: faults never reach BullMQ (rule 1)", () => {
  it("a tracer provider that throws gives a no-op span", () => {
    trace.setGlobalTracerProvider({
      getTracer() {
        throw new Error("getTracer fault");
      },
    });
    const t = bullmqTelemetry();
    const span = t.tracer.startSpan("add q.job", { kind: SpanKind.PRODUCER });
    expect(span.setSpanOnContext(ROOT_CONTEXT)).toBe(ROOT_CONTEXT);
    expect(() => {
      span.setAttribute("a", 1);
      span.setAttributes({ a: 1 });
      span.addEvent("job failed", { "bullmq.job.failed.reason": "x" });
      span.recordException("x");
      span.end();
    }).not.toThrow();
    expect(getFailureCounts().get("jobs.bullmq.tracer")).toBe(1);
  });

  it("a span whose every method throws is wrapped so that none of them throws", () => {
    const fault = () => {
      throw new Error("span fault");
    };
    const throwing = {
      spanContext: fault,
      setAttribute: fault,
      setAttributes: fault,
      addEvent: fault,
      addLink: fault,
      addLinks: fault,
      setStatus: fault,
      updateName: fault,
      end: fault,
      isRecording: fault,
      recordException: fault,
    };
    trace.setGlobalTracerProvider({
      getTracer: () => ({
        startSpan: () => throwing,
        startActiveSpan: fault,
      }),
    } as never);
    const t = bullmqTelemetry();
    const span = t.tracer.startSpan("process q", { kind: SpanKind.CONSUMER });
    expect(() => {
      span.setSpanOnContext(ROOT_CONTEXT);
      span.setAttribute("a", 1);
      span.setAttributes({ a: 1 });
      span.addEvent("job completed", { "bullmq.job.result": "1" });
      span.addEvent("job failed", { "bullmq.job.failed.reason": "x" });
      span.recordException(new Error("x"));
      span.end();
    }).not.toThrow();
    expect(getFailureCounts().get("jobs.bullmq.span")).toBeGreaterThanOrEqual(
      5,
    );
  });

  it("a context manager that throws: fn still runs exactly once, active() gives the root context", () => {
    const fault = () => {
      throw new Error("context fault");
    };
    context.disable();
    context.setGlobalContextManager({
      active: fault,
      with: fault,
      bind: fault,
      enable: () => undefined as never,
      disable: () => undefined as never,
    } as never);
    const t = bullmqTelemetry();
    let calls = 0;
    expect(t.contextManager.with(ROOT_CONTEXT, () => ++calls)).toBe(1);
    expect(calls).toBe(1);
    expect(t.contextManager.active()).toBe(ROOT_CONTEXT);
    expect(getFailureCounts().get("jobs.bullmq.context")).toBe(2);
  });

  it("a propagator that throws: getMetadata gives '{}', fromMetadata the active context", () => {
    const fault = () => {
      throw new Error("propagator fault");
    };
    propagation.disable();
    propagation.setGlobalPropagator({
      inject: fault,
      extract: fault,
      fields: () => [],
    });
    const t = bullmqTelemetry();
    expect(t.contextManager.getMetadata(ROOT_CONTEXT)).toBe("{}");
    const active: Context = ROOT_CONTEXT.setValue(Symbol("k"), 1);
    expect(t.contextManager.fromMetadata(active, '{"traceparent":"x"}')).toBe(
      active,
    );
  });

  it("options that throw on read are ignored", () => {
    const options = Object.defineProperty({}, "tracerName", {
      get() {
        throw new Error("options fault");
      },
    });
    expect(() => bullmqTelemetry(options)).not.toThrow();
  });
});

describe("bullmqTelemetry: metrics", () => {
  it("has no meter unless enableMetrics is true", () => {
    expect(bullmqTelemetry().meter).toBeUndefined();
    expect(bullmqTelemetry({ enableMetrics: false }).meter).toBeUndefined();
    expect(bullmqTelemetry({ enableMetrics: true }).meter).toBeDefined();
  });

  it("resolves its instruments on use, against a meter provider registered after it was created", () => {
    const t = bullmqTelemetry({
      enableMetrics: true,
      tracerName: "my-app",
      version: "2",
    });
    const counter = t.meter?.createCounter("bullmq.jobs.completed", {
      unit: "1",
    });
    const histogram = t.meter?.createHistogram("bullmq.job.duration", {
      unit: "ms",
    });
    const gauge = t.meter?.createGauge("bullmq.queue.jobs");
    expect(t.meter?.createCounter("bullmq.jobs.completed")).toBe(counter);

    const recorded: unknown[][] = [];
    const meters: unknown[][] = [];
    const instrument = (kind: string, name: string) => ({
      add: (v: number, a?: unknown) => recorded.push([kind, name, v, a]),
      record: (v: number, a?: unknown) => recorded.push([kind, name, v, a]),
    });
    metrics.setGlobalMeterProvider({
      getMeter: (name: string, version?: string) => {
        meters.push([name, version]);
        return {
          createCounter: (n: string) => instrument("counter", n),
          createHistogram: (n: string) => instrument("histogram", n),
          createGauge: (n: string) => instrument("gauge", n),
        };
      },
    } as never);

    counter?.add(1, { "bullmq.queue.name": "q" });
    counter?.add(2);
    histogram?.record(12);
    gauge?.record(3);
    expect(meters).toEqual([["my-app", "2"]]);
    expect(recorded).toEqual([
      ["counter", "bullmq.jobs.completed", 1, { "bullmq.queue.name": "q" }],
      ["counter", "bullmq.jobs.completed", 2, undefined],
      ["histogram", "bullmq.job.duration", 12, undefined],
      ["gauge", "bullmq.queue.jobs", 3, undefined],
    ]);
  });

  it("a meter that throws never reaches BullMQ", () => {
    metrics.setGlobalMeterProvider({
      getMeter() {
        throw new Error("meter fault");
      },
    } as never);
    const t = bullmqTelemetry({ enableMetrics: true });
    expect(() => {
      t.meter?.createCounter("c").add(1);
      t.meter?.createHistogram("h").record(1);
      t.meter?.createGauge("g").record(1);
    }).not.toThrow();
    expect(getFailureCounts().get("jobs.bullmq.meter")).toBe(3);
  });
});
