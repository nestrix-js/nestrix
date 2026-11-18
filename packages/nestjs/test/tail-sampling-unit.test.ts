// The registry alone (no SDK): the held-span bound and the lines held for undecided traces (D-100).
import { describe, expect, it } from "vitest";
import type { TraceLogInput } from "../src/logs/sink.js";
import { MAX_HELD_LOGS_PER_TRACE, TailRegistry } from "../src/tail-sampling.js";

const id = (n: number) => n.toString(16).padStart(32, "0");
const line = (traceId: string, body = "x"): TraceLogInput => ({
  traceId,
  spanId: "a".repeat(16),
  timeUnixMs: 1,
  level: "log",
  body,
  context: undefined,
});

describe("held-span bound", () => {
  it("never holds more than maxSpans, and evicts traces that hold spans before idle roots", () => {
    const registry = new TailRegistry<number>({ maxSpans: 100, maxTraces: 50 });
    for (let i = 0; i < 49; i++) registry.rootStarted(id(i)); // idle: nothing ended under them
    const busy = id(1000);
    registry.rootStarted(busy);
    expect(registry.pendingTraces).toBe(50);
    let max = 0;
    for (let i = 0; i < 1000; i++) {
      registry.childEnded(busy, i, false);
      max = Math.max(max, registry.buffered);
    }
    expect(max).toBeLessThanOrEqual(100);
    expect(registry.buffered).toBeLessThanOrEqual(100);
    // Only the busy trace was evicted; every idle root is still undecided.
    for (let i = 0; i < 49; i++) expect(registry.isRecording(id(i))).toBe(true);
    expect(registry.isRecording(busy)).toBe(false);
    expect(registry.pendingTraces).toBe(49);
    expect(registry.droppedSpans).toBeGreaterThan(0);
  });

  it("evicts the oldest trace that holds something, not the oldest trace", () => {
    const registry = new TailRegistry<number>({ maxSpans: 4, maxTraces: 10 });
    registry.rootStarted(id(1)); // oldest, idle
    registry.rootStarted(id(2));
    registry.rootStarted(id(3));
    for (let i = 0; i < 2; i++) registry.childEnded(id(2), i, false);
    for (let i = 0; i < 2; i++) registry.childEnded(id(3), i, false);
    expect(registry.buffered).toBe(4);
    expect(registry.childEnded(id(3), 9, false)).toBe("held");
    expect(registry.isRecording(id(1))).toBe(true);
    expect(registry.isRecording(id(2))).toBe(false);
    expect(registry.buffered).toBe(3);
  });
});

describe("held log lines", () => {
  it("holds lines of an undecided trace and hands them back only when it is kept", () => {
    const registry = new TailRegistry<number>();
    registry.rootStarted(id(1));
    registry.rootStarted(id(2));
    expect(registry.holdLog(id(1), line(id(1)))).toBe("held");
    expect(registry.holdLog(id(2), line(id(2)))).toBe("held");
    expect(registry.buffered).toBe(2);
    expect(registry.rootEnded(id(1), true)?.logs).toHaveLength(1);
    expect(registry.rootEnded(id(2), false)?.logs).toEqual([]);
    expect(registry.buffered).toBe(0);
    // Decided: late lines follow the decision.
    expect(registry.holdLog(id(1), line(id(1)))).toBe("pass");
    expect(registry.holdLog(id(2), line(id(2)))).toBe("drop");
    expect(registry.holdLog(id(3), line(id(3)))).toBe("unknown");
  });

  it("counts lines of an evicted trace and past the per-trace cap as dropped", () => {
    const registry = new TailRegistry<number>({ maxSpans: 1000, maxTraces: 2 });
    registry.rootStarted(id(1));
    for (let i = 0; i < MAX_HELD_LOGS_PER_TRACE + 5; i++) {
      registry.holdLog(id(1), line(id(1)));
    }
    expect(registry.droppedLogs).toBe(5);
    expect(registry.buffered).toBe(MAX_HELD_LOGS_PER_TRACE);
    registry.rootStarted(id(2));
    registry.rootStarted(id(3)); // over maxTraces: the oldest goes with its lines
    expect(registry.droppedLogs).toBe(5 + MAX_HELD_LOGS_PER_TRACE);
    expect(registry.holdLog(id(1), line(id(1)))).toBe("drop");
  });

  it("counts held lines against the same bound as held spans", () => {
    const registry = new TailRegistry<number>({ maxSpans: 10, maxTraces: 10 });
    registry.rootStarted(id(1));
    registry.rootStarted(id(2));
    for (let i = 0; i < 8; i++) registry.holdLog(id(1), line(id(1)));
    for (let i = 0; i < 50; i++) registry.childEnded(id(2), i, false);
    expect(registry.buffered).toBeLessThanOrEqual(10);
  });
});
