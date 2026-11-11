// NestrixLogger and getTraceIds: correlation in text and JSON mode, and the "never throws" rule.
import "reflect-metadata";
import { context, INVALID_SPAN_CONTEXT, trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../../src/diagnostics.js";
import { MAX_BODY_LENGTH, NestrixLogger } from "../../src/logs/logger.js";
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
      logger.warn("a", "b", "Ctx");
      span.end();
    });
    const lines = output.lines();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(
        new RegExp(`trace_id=${HEX}{32} span_id=${HEX}{16}$`),
      );
    }
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
    expect(output.lines().join("\n")).not.toContain("trace_id");
  });

  it("a span whose spanContext() throws leaves the line unchanged", () => {
    const span = {
      spanContext() {
        return {
          get traceId(): string {
            throw new Error("getter broke");
          },
          spanId: "0".repeat(16),
          traceFlags: 1,
        };
      },
    } as unknown as Parameters<typeof trace.setSpan>[1];
    const logger = new NestrixLogger({ colors: false });
    context.with(trace.setSpan(context.active(), span), () => {
      expect(() => logger.log("still here")).not.toThrow();
    });
    const text = output.lines().join("\n");
    expect(text).toContain("still here");
    expect(text).not.toContain("trace_id");
  });
});

describe("log export from NestrixLogger", () => {
  function collect(): { body: unknown }[] {
    const records: { body: unknown }[] = [];
    setLogSink({
      emit(record: { body: unknown }) {
        records.push(record);
      },
    } as Parameters<typeof setLogSink>[0]);
    return records;
  }

  it("applies the host's redact option to exported bodies, text mode", () => {
    const records = collect();
    const logger = new NestrixLogger({ colors: false, redact: ["password"] });
    logger.log({ user: "ann", password: "hunter2" });
    const body = String(records[0]?.body);
    expect(body).toContain("[REDACTED]");
    expect(body).not.toContain("hunter2");
    expect(output.lines().join("\n")).not.toContain("hunter2");
  });

  it("applies the host's redact option to exported bodies, JSON mode", () => {
    const records = collect();
    const logger = new NestrixLogger({ json: true, redact: ["password"] });
    logger.log({ user: "ann", password: "hunter2" });
    const body = String(records[0]?.body);
    expect(body).toContain("[REDACTED]");
    expect(body).not.toContain("hunter2");
    expect(output.lines().join("\n")).not.toContain("hunter2");
  });

  it("calls a lazy message function exactly once", () => {
    const records = collect();
    let calls = 0;
    const logger = new NestrixLogger({ colors: false });
    logger.log(() => {
      calls++;
      return "lazy value";
    });
    expect(calls).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.body).toBe("lazy value");
    expect(output.lines().join("\n")).toContain("lazy value");
  });

  it("still throws a throwing lazy function to the caller", () => {
    collect();
    const logger = new NestrixLogger({ colors: false });
    expect(() =>
      logger.log(() => {
        throw new Error("lazy broke");
      }),
    ).toThrow("lazy broke");
  });

  it("caps the exported body at 8192 characters and ends it with an ellipsis", () => {
    const records = collect();
    const logger = new NestrixLogger({ colors: false });
    logger.log("x".repeat(MAX_BODY_LENGTH + 500));
    const body = String(records[0]?.body);
    expect(body).toBe(`${"x".repeat(8192)}…`);
    logger.log("short");
    expect(records[1]?.body).toBe("short");
  });
});
