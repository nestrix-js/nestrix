// NestrixLogger and getTraceIds: correlation in text and JSON mode, and the "never throws" rule.
import "reflect-metadata";
import { context, INVALID_SPAN_CONTEXT, trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../../src/diagnostics.js";
import { NestrixLogger } from "../../src/logs/logger.js";
import { setLogSink } from "../../src/logs/sink.js";
import { getTraceIds } from "../../src/logs/trace-ids.js";
import { captureOutput, registerHostTracing } from "./helpers.js";

let undo: () => void;
let output: ReturnType<typeof captureOutput>;

beforeEach(() => {
  resetDiagnosticsForTests();
  undo = registerHostTracing();
  output = captureOutput();
});
afterEach(() => {
  output.restore();
  setLogSink(undefined);
  undo();
});

const HEX = "[0-9a-f]";

describe("getTraceIds", () => {
  it("is undefined outside a span", () => {
    expect(getTraceIds()).toBeUndefined();
  });

  it("returns the ids of the active span, and the child's inside a child", () => {
    const tracer = trace.getTracer("test");
    tracer.startActiveSpan("outer", (outer) => {
      const ids = getTraceIds();
      expect(ids).toEqual({
        traceId: outer.spanContext().traceId,
        spanId: outer.spanContext().spanId,
      });
      tracer.startActiveSpan("inner", (inner) => {
        expect(getTraceIds()?.spanId).toBe(inner.spanContext().spanId);
        expect(getTraceIds()?.traceId).toBe(outer.spanContext().traceId);
        inner.end();
      });
      outer.end();
    });
    expect(getTraceIds()).toBeUndefined();
  });

  it("is undefined for a span with an invalid context", () => {
    const span = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
    context.with(trace.setSpan(context.active(), span), () => {
      expect(getTraceIds()).toBeUndefined();
    });
  });
});

describe("NestrixLogger, text mode", () => {
  it("appends trace_id and span_id inside a span and nothing outside", () => {
    const logger = new NestrixLogger("Ctx", { colors: false });
    logger.log("outside");
    let ids: ReturnType<typeof getTraceIds>;
    trace.getTracer("t").startActiveSpan("s", (span) => {
      ids = getTraceIds();
      logger.log("inside");
      span.end();
    });
    const [outside, inside] = output.lines();
    expect(outside).toContain("outside");
    expect(outside).not.toContain("trace_id");
    expect(inside).toContain("[Ctx] inside");
    expect(
      inside?.endsWith(` trace_id=${ids?.traceId} span_id=${ids?.spanId}`),
    ).toBe(true);
    expect(inside).toMatch(
      new RegExp(`trace_id=${HEX}{32} span_id=${HEX}{16}$`),
    );
  });

  it("prints each of several messages with the suffix", () => {
    const logger = new NestrixLogger({ colors: false });
    trace.getTracer("t").startActiveSpan("s", (span) => {
      logger.warn("a", "b");
      span.end();
    });
    const lines = output.lines();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) expect(line).toContain("trace_id=");
  });
});

describe("NestrixLogger, JSON mode", () => {
  it("adds trace_id and span_id fields inside a span, none outside", () => {
    const logger = new NestrixLogger({ json: true });
    logger.log("outside");
    trace.getTracer("t").startActiveSpan("s", (span) => {
      logger.log("inside");
      span.end();
    });
    const [outside, inside] = output.lines().map((l) => JSON.parse(l));
    expect(outside.message).toBe("outside");
    expect("trace_id" in outside).toBe(false);
    expect(inside.message).toBe("inside");
    expect(inside.trace_id).toMatch(new RegExp(`^${HEX}{32}$`));
    expect(inside.span_id).toMatch(new RegExp(`^${HEX}{16}$`));
    expect(inside.level).toBe("log");
  });
});

describe("failures never reach the caller", () => {
  it("a throwing sink is counted and the line still prints", () => {
    setLogSink({
      emit() {
        throw new Error("sink broke");
      },
    });
    const logger = new NestrixLogger({ colors: false });
    expect(() => logger.error("boom", "stack here")).not.toThrow();
    expect(output.lines().join("\n")).toContain("boom");
    expect(getFailureCounts().get("logs.emit")).toBe(1);
  });

  it("a throwing tracer API leaves the line unchanged", () => {
    const original = trace.getActiveSpan;
    trace.getActiveSpan = () => {
      throw new Error("api broke");
    };
    try {
      const logger = new NestrixLogger({ colors: false });
      expect(() => logger.log("still here")).not.toThrow();
    } finally {
      trace.getActiveSpan = original;
    }
    expect(output.lines().join("\n")).toContain("still here");
  });
});
