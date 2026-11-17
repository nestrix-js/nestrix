// emitLog (issue #36, D-89): an application's own logger sends records through the same path as
// NestrixLogger. The disabled path reads nothing from the record; faults never reach the caller;
// a ConsoleLogger subclass in a Nest app ships its already-redacted lines to /v1/logs with the
// request's trace and span ids.
import "reflect-metadata";
import { Controller, Get, Logger, type LogLevel, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { context, TraceFlags, trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../../src/diagnostics.js";
import { emitLog } from "../../src/index.js";
import {
  getLogSink,
  getTraceLogSink,
  type LogRecordInput,
  setLogSink,
  setTraceLogSink,
  type TraceLogInput,
} from "../../src/logs/sink.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import { AppLogger } from "../readme-samples/logs-own-logger.js";
import { logger as pinoLogger } from "../readme-samples/logs-pino.js";
import {
  captureOutput,
  type LogReceiver,
  registerHostTracing,
  startLogReceiver,
} from "./helpers.js";

/** A record whose every read is counted, to show what emitLog touches. */
function spyRecord(): {
  record: Parameters<typeof emitLog>[0];
  reads: string[];
} {
  const reads: string[] = [];
  const record = {} as Parameters<typeof emitLog>[0];
  for (const key of ["level", "message", "context", "error", "attributes"]) {
    Object.defineProperty(record, key, {
      get() {
        reads.push(key);
        return key === "level" ? "log" : "x";
      },
    });
  }
  return { record, reads };
}

describe("emitLog, unit", () => {
  let undo: () => void;
  let exported: LogRecordInput[];
  let kept: TraceLogInput[];

  beforeEach(() => {
    resetDiagnosticsForTests();
    undo = registerHostTracing();
    exported = [];
    kept = [];
  });
  afterEach(() => {
    setLogSink(undefined);
    setTraceLogSink(undefined);
    undo();
  });

  function slots(): void {
    setLogSink({ emit: (r) => exported.push(r) });
    setTraceLogSink({ add: (r) => kept.push(r) });
  }

  it("with no slot filled (Nestrix disabled) reads nothing from the record and records nothing", () => {
    expect(getLogSink()).toBeUndefined();
    expect(getTraceLogSink()).toBeUndefined();
    const { record, reads } = spyRecord();
    expect(() => emitLog(record)).not.toThrow();
    expect(reads).toEqual([]);
    expect(getFailureCounts().size).toBe(0);
  });

  it("exports with the active span's ids and keeps the line next to a recording span's trace", () => {
    slots();
    let ids: { traceId: string; spanId: string } | undefined;
    trace.getTracer("t").startActiveSpan("s", (span) => {
      ids = {
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
      };
      emitLog({
        level: "warn",
        message: "inside",
        context: "Billing",
        attributes: { "tenant.id": "t1" },
      });
      span.end();
    });
    expect(exported).toEqual([
      {
        level: "warn",
        body: "inside",
        context: "Billing",
        stack: undefined,
        attributes: { "tenant.id": "t1" },
      },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      ...ids,
      level: "warn",
      body: "inside",
      context: "Billing",
    });
    expect(kept[0]).not.toHaveProperty("attributes");
  });

  it("keeps nothing in the store outside a span or under a non-recording span, and still exports", () => {
    slots();
    emitLog({ level: "log", message: "outside" });
    const unsampled = trace.wrapSpanContext({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: TraceFlags.NONE,
    });
    context.with(trace.setSpan(context.active(), unsampled), () => {
      emitLog({ level: "log", message: "unsampled" });
    });
    expect(kept).toEqual([]);
    expect(exported.map((r) => r.body)).toEqual(["outside", "unsampled"]);
  });

  it("applies NestrixLogger's body rules: 8 KiB cap, Error message, JSON, unserialisable values", () => {
    slots();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    emitLog({ level: "log", message: "y".repeat(9000) });
    emitLog({ level: "log", message: new Error("bad thing") });
    emitLog({ level: "log", message: { a: 1 } });
    emitLog({ level: "log", message: circular });
    expect(exported.map((r) => r.body)).toEqual([
      `${"y".repeat(8192)}…`,
      "bad thing",
      '{"a":1}',
      "[object Object]",
    ]);
  });

  it("sends an Error's stack or a stack string, and maps an unknown level to 'log'", () => {
    slots();
    const error = new Error("boom");
    emitLog({ level: "error", message: "failed", error });
    emitLog({ level: "error", message: "failed", error: "stack line" });
    emitLog({ level: "error", message: "failed", error: 42 });
    emitLog({ level: "info" as LogLevel, message: "pino info" });
    emitLog({ level: "log", message: "empty context", context: "" });
    expect(exported.map((r) => r.stack)).toEqual([
      error.stack,
      "stack line",
      undefined,
      undefined,
      undefined,
    ]);
    expect(exported[3]?.level).toBe("log");
    expect(exported[4]?.context).toBeUndefined();
  });

  it("never throws: a throwing export slot, trace slot or record getter is counted", () => {
    setLogSink({
      emit() {
        throw new Error("sink broke");
      },
    });
    setTraceLogSink({
      add() {
        throw new Error("store broke");
      },
    });
    trace.getTracer("t").startActiveSpan("s", (span) => {
      expect(() => emitLog({ level: "log", message: "x" })).not.toThrow();
      span.end();
    });
    expect(getFailureCounts().get("logs.trace")).toBe(1);
    expect(getFailureCounts().get("logs.emit")).toBe(1);

    const bad = {
      get level(): LogLevel {
        throw new Error("getter broke");
      },
      message: "x",
    };
    expect(() => emitLog(bad)).not.toThrow();
    expect(getFailureCounts().get("logs.emit")).toBe(2);
    expect(() =>
      emitLog(null as unknown as Parameters<typeof emitLog>[0]),
    ).not.toThrow();
    expect(getFailureCounts().get("logs.emit")).toBe(3);
  });

  it("a throwing tracer API is counted and the record is still exported", () => {
    slots();
    const original = trace.getActiveSpan;
    trace.getActiveSpan = () => {
      throw new Error("api broke");
    };
    try {
      expect(() => emitLog({ level: "log", message: "x" })).not.toThrow();
    } finally {
      trace.getActiveSpan = original;
    }
    expect(exported).toHaveLength(1);
    expect(getFailureCounts().get("logs.trace")).toBe(1);
  });
});

@Controller()
class WorkController {
  private readonly logger = new Logger("Work");
  @Get("work")
  work(): string {
    this.logger.log("charging card token=sk_live_123");
    this.logger.error("charge failed token=sk_live_456", "Error: x\n    at y");
    this.logger.warn({ user: "ann", password: "hunter2" });
    return "ok";
  }
}

describe("emitLog from a ConsoleLogger subclass in a Nest app", () => {
  let receiver: LogReceiver;
  beforeEach(async () => {
    resetDiagnosticsForTests();
    receiver = await startLogReceiver();
  });
  afterEach(async () => {
    await receiver.close();
  });

  async function run(enabled: boolean): Promise<string[]> {
    @Module({
      imports: [
        NestrixModule.forRoot({
          enabled,
          ui: false,
          logs: { export: true },
          export: { otlp: { endpoint: receiver.baseUrl, timeoutMillis: 2000 } },
        }),
      ],
      controllers: [WorkController],
    })
    class TestModule {}

    const output = captureOutput();
    try {
      const app = await NestFactory.create(TestModule, {
        logger: new AppLogger({ json: true, redact: ["password"] }),
      });
      await app.listen(0, "127.0.0.1");
      const { port } = app.getHttpServer().address() as { port: number };
      if (enabled) {
        const deadline = Date.now() + 5000;
        while (!getLogSink()) {
          if (Date.now() > deadline)
            throw new Error("log export never became ready");
          await new Promise((r) => setTimeout(r, 5));
        }
      }
      const res = await fetch(`http://127.0.0.1:${port}/work`);
      expect(await res.text()).toBe("ok");
      await app.close();
      return output.lines();
    } finally {
      output.restore();
    }
  }

  it("ships the lines to /v1/logs with trace and span ids, after the subclass's redaction", async () => {
    const lines = await run(true);
    const printed = lines.join("\n");
    expect(printed).not.toContain("sk_live");

    const charging = receiver.logs.find((l) =>
      String(l.body).startsWith("charging card"),
    );
    const failed = receiver.logs.find((l) =>
      String(l.body).startsWith("charge failed"),
    );
    expect(charging?.body).toBe("charging card token=[REDACTED]");
    expect(failed?.body).toBe("charge failed token=[REDACTED]");
    expect(JSON.stringify(receiver.logs)).not.toContain("sk_live");
    expect(printed).not.toContain("hunter2");
    expect(JSON.stringify(receiver.logs)).not.toContain("hunter2");
    const structured = receiver.logs.find((l) =>
      String(l.body).includes('"user":"ann"'),
    );
    expect(structured?.body).toContain("[REDACTED]");
    expect(structured?.traceId).toBe(charging?.traceId);
    expect(charging?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(charging?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(failed?.traceId).toBe(charging?.traceId);
    expect(charging?.attributes["nestrix.log.context"]).toBe("Work");
    expect(charging?.severityText).toBe("LOG");
    expect(failed?.severityText).toBe("ERROR");
    expect(failed?.attributes["exception.stacktrace"]).toBe(
      "Error: x\n    at y",
    );
    expect(getFailureCounts().size).toBe(0);
  });

  it("with Nestrix disabled is a no-op: the app logs as usual and nothing is exported", async () => {
    const lines = await run(false);
    expect(lines.join("\n")).toContain("charging card token=[REDACTED]");
    await new Promise((r) => setTimeout(r, 200));
    expect(receiver.logs).toEqual([]);
    expect(receiver.paths).toEqual([]);
    expect(getLogSink()).toBeUndefined();
    expect(getFailureCounts().size).toBe(0);
  });
});

describe("the README's pino destination", () => {
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
    setTraceLogSink(undefined);
    undo();
  });

  it("exports pino lines after pino's redact, with the caller's span ids", () => {
    const exported: LogRecordInput[] = [];
    setLogSink({ emit: (r) => exported.push(r) });
    // The trace slot sees the span active when emitLog runs: pino must call the stream synchronously.
    const kept: TraceLogInput[] = [];
    setTraceLogSink({ add: (r) => kept.push(r) });
    let spanId = "";
    trace.getTracer("t").startActiveSpan("s", (span) => {
      spanId = span.spanContext().spanId;
      pinoLogger.warn(
        { password: "hunter2", context: "Billing" },
        "card declined",
      );
      pinoLogger.error({ err: new Error("gateway down") }, "charge failed");
      span.end();
    });
    expect(output.lines().join("\n")).not.toContain("hunter2");
    expect(exported.map((r) => [r.level, r.body, r.context])).toEqual([
      ["warn", "card declined", "Billing"],
      ["error", "charge failed", undefined],
    ]);
    expect(exported[1]?.stack).toContain("Error: gateway down");
    expect(JSON.stringify(exported)).not.toContain("hunter2");
    expect(kept.map((r) => r.spanId)).toEqual([spanId, spanId]);
  });
});
