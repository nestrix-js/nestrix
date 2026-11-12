// P13-01 (D-78): the per-trace counter, the limiting sampler and the limit processor, on a private
// TracerProvider (nothing registered globally; parents passed as explicit contexts).
import {
  type Context,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  trace,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  AlwaysOnSampler,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLimitingSampler,
  createSpanLimitProcessor,
} from "../src/otel/span-limit.js";
import {
  ATTR_SPANS_DROPPED,
  dropKindOf,
  TraceSpanCounter,
} from "../src/trace-limit.js";
import { recordingDiagnostics } from "./otel-helpers.js";

function rig(limit: number, counter = new TraceSpanCounter(limit)) {
  const exporter = new InMemorySpanExporter();
  const diagnostics = recordingDiagnostics();
  const provider = new TracerProvider({
    sampler: createLimitingSampler(
      new ParentBasedSampler({ root: new AlwaysOnSampler() }),
      counter,
      diagnostics,
    ),
    spanProcessors: [
      createSpanLimitProcessor(counter, diagnostics),
      new SimpleSpanProcessor({ exporter }),
    ],
  });
  const tracer = provider.getTracer("span-limit-unit");
  const child = (
    name: string,
    parent: Span,
    kind?: SpanKind,
    attributes?: Record<string, string>,
  ) =>
    tracer.startSpan(
      name,
      { kind, attributes },
      trace.setSpan(ROOT_CONTEXT, parent),
    );
  return { exporter, diagnostics, provider, tracer, counter, child };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("limiting sampler and processor", () => {
  it("25,000 spans (root + 24,999 children), limit 10,000: 10,000 recorded with the root, 15,000 counted by kind on the root", () => {
    const { exporter, tracer, counter, child } = rig(10_000);
    const root = tracer.startSpan("job", { kind: SpanKind.CONSUMER });
    const traceId = root.spanContext().traceId;
    for (let i = 0; i < 24_999; i++) {
      // 5 kinds in turn.
      const s =
        i % 5 === 0
          ? child("SELECT row", root, SpanKind.CLIENT, {
              "db.system.name": "postgresql",
            })
          : i % 5 === 1
            ? child("GET", root, SpanKind.CLIENT, {
                "http.request.method": "GET",
              })
            : i % 5 === 2
              ? child("GET key", root, SpanKind.CLIENT, {
                  "db.system.name": "redis",
                })
              : i % 5 === 3
                ? child("Svc.m", root, SpanKind.INTERNAL, {
                    "nestrix.class": "Svc",
                  })
                : child("x", root);
      s.end();
    }
    expect(counter.size).toBe(1);
    root.end();
    expect(counter.size).toBe(0);
    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(10_000);
    expect(finished.every((s) => s.spanContext().traceId === traceId)).toBe(
      true,
    );
    const exportedRoot = finished.find((s) => s.name === "job");
    expect(exportedRoot?.attributes).toMatchObject({
      [ATTR_SPANS_DROPPED]: 15_000,
    });
    // Children 0..9,998 recorded; 9,999..24,998 dropped: 15,000 in a row, 3,000 of each kind.
    const byKind = Object.fromEntries(
      Object.entries(exportedRoot?.attributes ?? {}).filter(([k]) =>
        k.startsWith(`${ATTR_SPANS_DROPPED}.`),
      ),
    );
    expect(byKind).toEqual({
      [`${ATTR_SPANS_DROPPED}.db`]: 3_000,
      [`${ATTR_SPANS_DROPPED}.http-out`]: 3_000,
      [`${ATTR_SPANS_DROPPED}.redis`]: 3_000,
      [`${ATTR_SPANS_DROPPED}.app`]: 3_000,
      [`${ATTR_SPANS_DROPPED}.other`]: 3_000,
    });
  });

  it("children of a dropped span are dropped and counted; recorded parents keep recording until the limit", () => {
    const { exporter, tracer, child } = rig(100);
    const root = tracer.startSpan("root");
    const recorded: Span[] = [];
    for (let i = 0; i < 99; i++) recorded.push(child("c", root));
    const dropped = child("over", root);
    expect(dropped.isRecording()).toBe(false);
    // Grandchildren of a dropped span: not recorded, counted.
    for (let i = 0; i < 10; i++) {
      const g = child("grand", dropped as Span);
      expect(g.isRecording()).toBe(false);
      g.end();
    }
    // Children of a recorded span past the limit: dropped too (the trace is full).
    const late = child("late", recorded[0] as Span);
    expect(late.isRecording()).toBe(false);
    dropped.end();
    for (const r of recorded) r.end();
    root.end();
    const out = exporter.getFinishedSpans();
    expect(out).toHaveLength(100);
    expect(out.find((s) => s.name === "root")?.attributes).toMatchObject({
      [ATTR_SPANS_DROPPED]: 12,
      [`${ATTR_SPANS_DROPPED}.other`]: 12,
    });
  });

  it("traceparent from a dropped span carries the trace id with sampled 00; from a recorded span 01", () => {
    const { tracer, child } = rig(100);
    const propagator = new W3CTraceContextPropagator();
    const root = tracer.startSpan("root");
    const kept = child("kept", root);
    for (let i = 0; i < 98; i++) child("c", root).end();
    const dropped = child("dropped", root);
    const headerOf = (span: Span) => {
      const carrier: Record<string, string> = {};
      propagator.inject(trace.setSpan(ROOT_CONTEXT, span), carrier, {
        set: (c, k, v) => {
          c[k] = v;
        },
      });
      return carrier.traceparent;
    };
    const traceId = root.spanContext().traceId;
    expect(headerOf(kept)).toMatch(
      new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`),
    );
    expect(headerOf(dropped)).toMatch(
      new RegExp(`^00-${traceId}-[0-9a-f]{16}-00$`),
    );
    root.end();
  });

  it("two concurrent traces are counted separately", () => {
    const { exporter, tracer, child, counter } = rig(100);
    const a = tracer.startSpan("a");
    const b = tracer.startSpan("b");
    for (let i = 0; i < 150; i++) {
      child("a.c", a).end();
      if (i < 120) child("b.c", b).end();
    }
    expect(counter.size).toBe(2);
    a.end();
    b.end();
    const out = exporter.getFinishedSpans();
    expect(out.filter((s) => s.name.startsWith("a"))).toHaveLength(100);
    expect(out.filter((s) => s.name.startsWith("b"))).toHaveLength(100);
    expect(
      out.find((s) => s.name === "a")?.attributes[ATTR_SPANS_DROPPED],
    ).toBe(51);
    expect(
      out.find((s) => s.name === "b")?.attributes[ATTR_SPANS_DROPPED],
    ).toBe(21);
    expect(counter.size).toBe(0);
  });

  it("a trace under the limit gets no attribute", () => {
    const { exporter, tracer, child } = rig(100);
    const root = tracer.startSpan("root");
    for (let i = 0; i < 99; i++) child("c", root).end();
    root.end();
    const out = exporter.getFinishedSpans();
    expect(out).toHaveLength(100);
    expect(
      Object.keys(out.find((s) => s.name === "root")?.attributes ?? {}),
    ).not.toContain(ATTR_SPANS_DROPPED);
  });

  it("each local root with a remote parent carries its own share of the drops", () => {
    const { exporter, tracer } = rig(100);
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const remote = (spanId: string): Context =>
      trace.setSpanContext(ROOT_CONTEXT, {
        traceId,
        spanId,
        traceFlags: 1,
        isRemote: true,
      });
    const r1 = tracer.startSpan("server-1", {}, remote("00f067aa0ba902b7"));
    const r2 = tracer.startSpan("server-2", {}, remote("00f067aa0ba902b8"));
    for (let i = 0; i < 120; i++) {
      tracer.startSpan("c", {}, trace.setSpan(ROOT_CONTEXT, r1)).end();
    }
    r1.end();
    for (let i = 0; i < 5; i++) {
      tracer.startSpan("c", {}, trace.setSpan(ROOT_CONTEXT, r2)).end();
    }
    r2.end();
    const out = exporter.getFinishedSpans();
    // 2 roots + 98 children recorded; 22 dropped under r1, then 5 under r2.
    expect(out).toHaveLength(100);
    expect(
      out.find((s) => s.name === "server-1")?.attributes[ATTR_SPANS_DROPPED],
    ).toBe(22);
    expect(
      out.find((s) => s.name === "server-2")?.attributes[ATTR_SPANS_DROPPED],
    ).toBe(5);
  });

  it("onEnding runs before onEnd for every processor (sdk-trace 3.1.1): the exporter sees the attribute", () => {
    // Pinned: if a later SDK stops calling onEnding, this fails instead of silently losing counts.
    const { exporter, tracer, child } = rig(100);
    const root = tracer.startSpan("root");
    for (let i = 0; i < 101; i++) child("c", root).end();
    root.end();
    const exported = exporter.getFinishedSpans().find((s) => s.name === "root");
    expect(exported?.attributes[ATTR_SPANS_DROPPED]).toBe(2);
  });
});

describe("faults never reach the host", () => {
  it("a throwing counter: the sampler answers as the inner sampler, spans are recorded, failures counted", () => {
    const counter = new TraceSpanCounter(100);
    vi.spyOn(counter, "tryRecord").mockImplementation(() => {
      throw new Error("boom");
    });
    vi.spyOn(counter, "rootEnding").mockImplementation(() => {
      throw new Error("boom");
    });
    const { exporter, tracer, child, diagnostics } = rig(100, counter);
    const root = tracer.startSpan("root");
    for (let i = 0; i < 150; i++) child("c", root).end();
    expect(() => root.end()).not.toThrow();
    expect(exporter.getFinishedSpans()).toHaveLength(151);
    const where = new Set(diagnostics.failures.map((f) => f.where));
    expect(where).toEqual(
      new Set(["trace-limit.sampler", "trace-limit.onEnding"]),
    );
  });

  it("a throwing dropDescendant and a span whose setAttribute throws: no throw out of start or end", () => {
    const counter = new TraceSpanCounter(100);
    vi.spyOn(counter, "dropDescendant").mockImplementation(() => {
      throw new Error("boom");
    });
    const { tracer, child, diagnostics } = rig(100, counter);
    const root = tracer.startSpan("root");
    for (let i = 0; i < 100; i++) child("c", root).end();
    const over = child("over", root);
    expect(() => child("grand", over).end()).not.toThrow();
    (root as unknown as { setAttribute: () => never }).setAttribute = () => {
      throw new Error("setAttribute");
    };
    expect(() => root.end()).not.toThrow();
    const where = diagnostics.failures.map((f) => f.where);
    expect(where).toContain("trace-limit.sampler");
    expect(where).toContain("trace-limit.onEnding");
    // The trace was still forgotten.
    expect(counter.size).toBe(0);
  });
});

describe("TraceSpanCounter", () => {
  it("stays bounded: at most maxTraces live traces, the oldest forgotten first", () => {
    const counter = new TraceSpanCounter(100, { maxTraces: 50 });
    for (let i = 0; i < 1_000; i++) {
      counter.tryRecord(i.toString(16).padStart(32, "0"), undefined, {});
    }
    expect(counter.size).toBe(50);
    expect(counter.evicted).toBe(950);
  });

  it("forgets traces idle for longer than idleMillis", () => {
    let now = 0;
    const counter = new TraceSpanCounter(100, {
      idleMillis: 1_000,
      now: () => now,
    });
    for (let i = 0; i < 20; i++) {
      counter.tryRecord(`old-${i}`, undefined, {});
    }
    now = 5_000;
    // Each insertion looks at up to 8 entries at the head.
    for (let i = 0; i < 3; i++) counter.tryRecord(`new-${i}`, undefined, {});
    expect(counter.size).toBe(3);
    expect(counter.evicted).toBe(0);
  });

  it("a busy head entry does not hide idle ones behind it", () => {
    let now = 0;
    const counter = new TraceSpanCounter(100, {
      idleMillis: 1_000,
      now: () => now,
    });
    counter.tryRecord("busy", undefined, {});
    for (let i = 0; i < 5; i++) counter.tryRecord(`idle-${i}`, undefined, {});
    now = 5_000;
    // Still live: the clock is read on every 64th touch.
    for (let i = 0; i < 64; i++) counter.tryRecord("busy", undefined, {});
    counter.tryRecord("n1", undefined, {});
    counter.tryRecord("n2", undefined, {});
    expect(counter.size).toBe(3);
  });

  it("does not track a trace for a span it was not asked to record", () => {
    const counter = new TraceSpanCounter(100);
    counter.dropDescendant("t", SpanKind.CLIENT, {});
    expect(counter.size).toBe(0);
  });

  it("host mode: the first span is the root; drops counted; written on the root as it ends", () => {
    const counter = new TraceSpanCounter(100);
    const set: Record<string, unknown> = {};
    const root = {
      setAttribute(k: string, v: unknown) {
        set[k] = v;
        return root;
      },
    } as unknown as Span;
    counter.hostStarted("t", root);
    let admitted = 0;
    for (let i = 0; i < 150; i++) {
      if (counter.hostAdmit("t", SpanKind.CLIENT, { "db.system": "mysql" })) {
        admitted++;
      }
    }
    expect(admitted).toBe(99);
    counter.hostEnding("t", {} as Span); // not the root: nothing
    expect(counter.size).toBe(1);
    counter.hostEnding("t", root);
    expect(set).toEqual({
      [ATTR_SPANS_DROPPED]: 51,
      [`${ATTR_SPANS_DROPPED}.db`]: 51,
    });
    expect(counter.size).toBe(0);
  });
});

describe("dropKindOf", () => {
  it("uses the dashboard's time-by-kind keys", () => {
    expect(
      dropKindOf(SpanKind.CLIENT, { "db.system.name": "postgresql" }),
    ).toBe("db");
    expect(dropKindOf(SpanKind.CLIENT, { "db.system": "MySQL" })).toBe("db");
    expect(dropKindOf(SpanKind.CLIENT, { "db.system.name": "redis" })).toBe(
      "redis",
    );
    expect(dropKindOf(SpanKind.CLIENT, { "http.request.method": "GET" })).toBe(
      "http-out",
    );
    expect(dropKindOf(SpanKind.PRODUCER, {})).toBe("messaging");
    expect(dropKindOf(SpanKind.INTERNAL, { "messaging.system": "kafka" })).toBe(
      "messaging",
    );
    expect(
      dropKindOf(SpanKind.INTERNAL, { "nestrix.component": "service" }),
    ).toBe("app");
    expect(dropKindOf(SpanKind.INTERNAL, {})).toBe("other");
    expect(dropKindOf(undefined, undefined)).toBe("other");
  });
});
