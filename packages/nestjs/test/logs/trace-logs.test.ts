// P9-07: NestrixLogger lines kept in the dashboard store next to their trace. The store's bounds
// (per-trace cap, byte budget, eviction with the trace), the "only with a recording span" rule,
// redaction and the body cap, and fault injection (a throwing store never fails a log call).
import "reflect-metadata";
import { context, trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../../src/diagnostics.js";
import { MAX_BODY_LENGTH, NestrixLogger } from "../../src/logs/logger.js";
import { getTraceLogSink, setTraceLogSink } from "../../src/logs/sink.js";
import { MAX_LOGS_PER_TRACE } from "../../src/store/limits.js";
import { createStoreProcessor } from "../../src/store/processor.js";
import { getOrCreateStore, resetStoreForTests } from "../../src/store/store.js";
import { recordingDiagnostics } from "../otel-helpers.js";
import { serverRoot, traceId } from "../store-helpers.js";
import { captureOutput, registerHostTracing } from "./helpers.js";

let undo: () => void;
let output: ReturnType<typeof captureOutput>;

beforeEach(() => {
  resetDiagnosticsForTests();
  resetStoreForTests();
  undo = registerHostTracing();
  output = captureOutput();
});
afterEach(() => {
  output.restore();
  resetStoreForTests();
  undo();
});

const SPAN = "00000000000000aa";

type Store = ReturnType<typeof getOrCreateStore>;
type Line = Parameters<Store["addLog"]>[0];

function line(n: number, over: Partial<Line> = {}): Line {
  return {
    traceId: traceId(n),
    spanId: SPAN,
    timeUnixMs: 1_700_000_000_000,
    level: "log",
    body: "hello",
    context: "Ctx",
    ...over,
  };
}
function add(store: Store, record: Line): void {
  store.addLog(record);
}

describe("store: log lines next to a trace", () => {
  it("is the logger's trace slot only while attached", () => {
    const store = getOrCreateStore({}, recordingDiagnostics());
    expect(getTraceLogSink()).toBeUndefined();
    const detach = store.attach({});
    expect(getTraceLogSink()).toBeDefined();
    const detach2 = store.attach({});
    detach();
    expect(getTraceLogSink()).toBeDefined();
    detach2();
    expect(getTraceLogSink()).toBeUndefined();
    // Detached: lines are ignored.
    add(store, line(1));
    expect(store.getTraceLogs(traceId(1)).items).toEqual([]);
  });

  it("keeps lines with the trace, maps the level, and serves them oldest first", () => {
    const store = getOrCreateStore({}, recordingDiagnostics());
    store.attach({});
    add(store, line(1, { timeUnixMs: 20, level: "warn", body: "second" }));
    add(store, line(1, { timeUnixMs: 10, level: "error", body: "first" }));
    add(
      store,
      line(1, {
        timeUnixMs: 30,
        level: "verbose",
        context: undefined,
        spanId: "nope",
      }),
    );
    const r = store.getTraceLogs(traceId(1));
    expect(r.truncated).toBe(false);
    expect(r.items).toEqual([
      {
        timeUnixMs: 10,
        severity: 17,
        level: "error",
        context: "Ctx",
        message: "first",
        spanId: SPAN,
      },
      {
        timeUnixMs: 20,
        severity: 13,
        level: "warn",
        context: "Ctx",
        message: "second",
        spanId: SPAN,
      },
      // An invalid span id is left out; no context, no field.
      { timeUnixMs: 30, severity: 1, level: "verbose", message: "hello" },
    ]);
    // Other traces see nothing; a bad id answers empty.
    expect(store.getTraceLogs(traceId(2)).items).toEqual([]);
    expect(store.getTraceLogs("../../etc").items).toEqual([]);
    // A line with a malformed trace id is not kept.
    add(store, line(3, { traceId: "zz" }));
    expect(store.stats().logs).toBe(3);
  });

  it(`caps a trace at ${MAX_LOGS_PER_TRACE} lines and says so`, () => {
    const store = getOrCreateStore({}, recordingDiagnostics());
    store.attach({});
    for (let i = 0; i < MAX_LOGS_PER_TRACE + 25; i++) {
      add(store, line(1, { timeUnixMs: i, body: `l${i}` }));
    }
    const r = store.getTraceLogs(traceId(1));
    expect(r.items).toHaveLength(MAX_LOGS_PER_TRACE);
    expect(r.items.at(-1)?.message).toBe(`l${MAX_LOGS_PER_TRACE - 1}`);
    expect(r.truncated).toBe(true);
    expect(store.stats().droppedLogs).toBe(25);
  });

  it("counts lines in the byte budget and evicts them with their trace", () => {
    const store = getOrCreateStore(
      { maxBytes: 200_000 },
      recordingDiagnostics(),
    );
    store.attach({});
    const processor = createStoreProcessor(store);
    const root = serverRoot(1);
    processor.onEnd(root);
    store.drainNow();
    const before = store.stats().bytes;
    add(store, line(1, { body: "x".repeat(1000) }));
    // At least the message's UTF-16 bytes.
    expect(store.stats().bytes - before).toBeGreaterThanOrEqual(2000);
    // Fill the budget with other traces' lines: trace 1 (oldest) goes, its lines with it.
    for (let n = 2; n < 40; n++) {
      for (let i = 0; i < 5; i++)
        add(store, line(n, { body: "y".repeat(1000) }));
    }
    // Limits are enforced by the background drain, not in the logger call.
    store.drainNow();
    expect(store.getTrace(traceId(1))).toBeUndefined();
    expect(store.getTraceLogs(traceId(1)).items).toEqual([]);
    const stats = store.stats();
    expect(stats.bytes).toBeLessThanOrEqual(200_000);
    expect(stats.evictedTraces).toBeGreaterThan(0);
    // The live count matches what is held.
    let held = 0;
    for (let n = 1; n < 40; n++)
      held += store.getTraceLogs(traceId(n)).items.length;
    expect(stats.logs).toBe(held);
  });

  it("entries made only by log lines do not push out real traces, and are capped at 10% of maxTraces", () => {
    const store = getOrCreateStore({ maxTraces: 20 }, recordingDiagnostics());
    store.attach({});
    const processor = createStoreProcessor(store);
    for (let n = 1; n <= 20; n++) processor.onEnd(serverRoot(n));
    store.drainNow();
    // 100 traces known only by their log lines.
    for (let n = 101; n <= 200; n++) add(store, line(n));
    store.drainNow();
    // Every real trace is still there.
    for (let n = 1; n <= 20; n++) {
      expect(store.getTrace(traceId(n))).toBeDefined();
    }
    // Only the newest two (10% of 20) log-only entries remain; the oldest were dropped first.
    let kept = 0;
    for (let n = 101; n <= 200; n++) {
      if (store.getTraceLogs(traceId(n)).items.length > 0) kept++;
    }
    expect(kept).toBe(2);
    expect(store.getTraceLogs(traceId(200)).items).toHaveLength(1);
    expect(store.getTraceLogs(traceId(199)).items).toHaveLength(1);
    expect(store.getTraceLogs(traceId(101)).items).toEqual([]);
    // A log-only entry that gets its span becomes a real trace and counts as one.
    processor.onEnd(serverRoot(200));
    store.drainNow();
    expect(store.getTrace(traceId(200))).toBeDefined();
    expect(store.getTraceLogs(traceId(200)).items).toHaveLength(1);
  });

  it("the logger call does not enforce limits itself: a drain is scheduled instead", async () => {
    const store = getOrCreateStore({ maxTraces: 10 }, recordingDiagnostics());
    store.attach({});
    for (let n = 1; n <= 30; n++) add(store, line(n));
    // Nothing evicted synchronously.
    expect(store.stats().evictedTraces).toBe(0);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.stats().evictedTraces).toBe(29);
    expect(store.getTraceLogs(traceId(30)).items).toHaveLength(1);
  });

  it("attach({ keepLogs: false }) keeps no lines and leaves the logger's slot alone", () => {
    const store = getOrCreateStore({}, recordingDiagnostics());
    const detach = store.attach({ keepLogs: false });
    expect(getTraceLogSink()).toBeUndefined();
    detach();
  });

  it("a line that arrives before its spans: the trace is not listed or served until a span ends, then has its resource", () => {
    const store = getOrCreateStore({}, recordingDiagnostics());
    store.attach({});
    add(store, line(7));
    expect(store.getTrace(traceId(7))).toBeUndefined();
    expect(store.listTraces({ limit: 10 }).items).toEqual([]);
    let visited = 0;
    store.scanAllTraces(() => visited++);
    expect(visited).toBe(0);
    const processor = createStoreProcessor(store);
    processor.onEnd(serverRoot(7, { resource: { "service.name": "svc" } }));
    store.drainNow();
    const t = store.getTrace(traceId(7));
    expect(t?.spans).toHaveLength(1);
    expect(t?.resource["service.name"]).toBe("svc");
    expect(store.getTraceLogs(traceId(7)).items).toHaveLength(1);
  });
});

describe("NestrixLogger feeds the store", () => {
  it("keeps lines written under a recording span, redacted and capped; not outside a span", () => {
    const store = getOrCreateStore({}, recordingDiagnostics());
    store.attach({});
    const logger = new NestrixLogger({ colors: false, redact: ["password"] });
    let ids = { traceId: "", spanId: "" };
    trace.getTracer("t").startActiveSpan("req", (span) => {
      ids = span.spanContext();
      logger.log({ user: "a", password: "hunter2" }, "Auth");
      logger.warn("w".repeat(MAX_BODY_LENGTH + 100));
      span.end();
    });
    logger.log("outside");
    const r = store.getTraceLogs(ids.traceId);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      level: "log",
      severity: 9,
      context: "Auth",
      spanId: ids.spanId,
    });
    expect(r.items[0]?.message).not.toContain("hunter2");
    expect(r.items[0]?.message).toContain("[REDACTED]");
    expect(r.items[1]?.message).toHaveLength(MAX_BODY_LENGTH + 1);
    expect(r.items[1]?.message.endsWith("…")).toBe(true);
    expect(store.stats().logs).toBe(2);
  });

  it("does not keep lines under a non-recording span", () => {
    const store = getOrCreateStore({}, recordingDiagnostics());
    store.attach({});
    const logger = new NestrixLogger({ colors: false });
    const sampledOut = trace.wrapSpanContext({
      traceId: traceId(5),
      spanId: SPAN,
      traceFlags: 0,
    });
    context.with(trace.setSpan(context.active(), sampledOut), () => {
      logger.log("not sampled");
    });
    expect(store.getTraceLogs(traceId(5)).items).toEqual([]);
  });

  it("fault injection: a throwing trace slot is counted and the line still prints", () => {
    setTraceLogSink({
      add() {
        throw new Error("store broke");
      },
    });
    const logger = new NestrixLogger({ colors: false });
    trace.getTracer("t").startActiveSpan("req", (span) => {
      expect(() => logger.log("still printed")).not.toThrow();
      span.end();
    });
    expect(output.lines().some((l) => l.includes("still printed"))).toBe(true);
    expect(getFailureCounts().get("logs.trace")).toBe(1);
  });

  it("fault injection: a line logged from inside the trace slot is not fed back", () => {
    const logger = new NestrixLogger({ colors: false });
    let calls = 0;
    setTraceLogSink({
      add() {
        calls++;
        logger.log("from inside the sink");
      },
    });
    trace.getTracer("t").startActiveSpan("req", (span) => {
      logger.log("outer");
      span.end();
    });
    expect(calls).toBe(1);
    expect(output.lines().some((l) => l.includes("from inside the sink"))).toBe(
      true,
    );
  });

  it("a store whose addLog throws internally counts the failure and does not throw", () => {
    const diagnostics = recordingDiagnostics();
    const store = getOrCreateStore({}, diagnostics);
    store.attach({});
    // A body whose String() throws reaches the store's own guard.
    const evil = {
      toString: () => {
        throw new Error("boom");
      },
    };
    expect(() =>
      store.addLog(line(1, { body: evil as unknown as string })),
    ).not.toThrow();
    expect(store.getTraceLogs(traceId(1)).items).toEqual([]);
  });
});
