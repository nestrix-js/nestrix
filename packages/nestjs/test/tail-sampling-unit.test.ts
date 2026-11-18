// The registry alone (no SDK): the held-span bound and the lines held for undecided traces (D-100).
import { describe, expect, it } from "vitest";
import type { TraceLogInput } from "../src/logs/sink.js";
import {
  heldLogBytes,
  holdTraceLog,
  installTailRegistry,
  MAX_BUFFERED_SPANS,
  MAX_HELD_LOG_BYTES,
  MAX_HELD_LOGS_PER_TRACE,
  MAX_TAIL_TRACES,
  TailRegistry,
} from "../src/tail-sampling.js";

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

describe("held log bytes", () => {
  const big = (traceId: string) => line(traceId, "y".repeat(8192));

  it("drops a line that would take the held bytes over the budget, and counts it", () => {
    const one = heldLogBytes(big(id(1)));
    const registry = new TailRegistry<number>({ maxLogBytes: one * 3 });
    registry.rootStarted(id(1));
    registry.rootStarted(id(2));
    expect(registry.holdLog(id(1), big(id(1)))).toBe("held");
    expect(registry.holdLog(id(1), big(id(1)))).toBe("held");
    expect(registry.holdLog(id(2), big(id(2)))).toBe("held");
    expect(registry.bufferedLogBytes).toBe(one * 3);
    // Over the budget: dropped and counted, whichever trace it belongs to; nothing is evicted.
    expect(registry.holdLog(id(2), big(id(2)))).toBe("drop");
    expect(registry.holdLog(id(1), line(id(1)))).toBe("drop");
    expect(registry.droppedLogs).toBe(2);
    expect(registry.isRecording(id(1))).toBe(true);
    expect(registry.droppedSpans).toBe(0);
    expect(registry.bufferedLogBytes).toBeLessThanOrEqual(one * 3);
  });

  it("gives the bytes back when a trace is kept, dropped or evicted", () => {
    const one = heldLogBytes(big(id(1)));
    const registry = new TailRegistry<number>({
      maxLogBytes: one * 2,
      maxTraces: 2,
    });
    registry.rootStarted(id(1));
    registry.rootStarted(id(2));
    registry.holdLog(id(1), big(id(1)));
    registry.holdLog(id(2), big(id(2)));
    expect(registry.rootEnded(id(1), true)?.logs).toHaveLength(1);
    expect(registry.bufferedLogBytes).toBe(one);
    registry.rootEnded(id(2), false);
    expect(registry.bufferedLogBytes).toBe(0);

    registry.rootStarted(id(3));
    registry.rootStarted(id(4));
    registry.holdLog(id(3), big(id(3)));
    registry.holdLog(id(4), big(id(4)));
    registry.rootStarted(id(5)); // over maxTraces: id(3) is evicted with its line
    expect(registry.bufferedLogBytes).toBe(one);
    expect(registry.holdLog(id(5), big(id(5)))).toBe("held");
    expect(registry.bufferedLogBytes).toBe(one * 2);
    registry.clear();
    expect(registry.bufferedLogBytes).toBe(0);
  });

  it("keeps the default worst case within the budget: every trace holding its cap of 8 KiB lines", () => {
    const registry = new TailRegistry<number>();
    const traces = Math.ceil(MAX_BUFFERED_SPANS / MAX_HELD_LOGS_PER_TRACE);
    expect(traces).toBeLessThanOrEqual(MAX_TAIL_TRACES);
    let held = 0;
    for (let t = 0; t < traces; t++) {
      registry.rootStarted(id(t));
      for (let i = 0; i < MAX_HELD_LOGS_PER_TRACE; i++) {
        if (registry.holdLog(id(t), big(id(t))) === "held") held++;
      }
    }
    expect(registry.bufferedLogBytes).toBeLessThanOrEqual(MAX_HELD_LOG_BYTES);
    expect(held).toBe(
      Math.floor(MAX_HELD_LOG_BYTES / heldLogBytes(big(id(0)))),
    );
    expect(registry.droppedLogs).toBe(traces * MAX_HELD_LOGS_PER_TRACE - held);
    // Without the byte budget this would have held 10,000 lines, about 160 MiB of UTF-16 text.
    expect(held).toBeLessThan(MAX_BUFFERED_SPANS / 10);
  });

  it("never throws from holdTraceLog, even for a line whose fields throw (rule 1)", () => {
    const registry = new TailRegistry<number>();
    const uninstall = installTailRegistry(registry as TailRegistry<unknown>);
    try {
      registry.rootStarted(id(9));
      const hostile = {
        traceId: id(9),
        spanId: "a".repeat(16),
        timeUnixMs: 1,
        level: "log",
        get body(): string {
          throw new Error("boom");
        },
        context: undefined,
      } as unknown as TraceLogInput;
      expect(holdTraceLog(hostile)).toBe("drop");
      expect(registry.bufferedLogBytes).toBe(0);
      expect(registry.buffered).toBe(0);
      expect(holdTraceLog(line(id(9)))).toBe("held");
    } finally {
      uninstall();
    }
  });
});
