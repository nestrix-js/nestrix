import type { RuntimeSample } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  cpuLevel,
  formatMemory,
  formatMemoryAxis,
  formatPercent,
  formatUptime,
  heapLevel,
  loopLevel,
  present,
  runtimeCharts,
} from "@/views/runtime/runtime-format";

const sample = (over: Partial<RuntimeSample>): RuntimeSample => ({
  timeUnixMs: 10_000,
  eventLoopP50Ms: 1,
  eventLoopP99Ms: 2,
  eventLoopMaxMs: 3,
  heapUsedBytes: 10,
  heapTotalBytes: 20,
  rssBytes: 30,
  externalBytes: 4,
  cpuUserPercent: 5,
  cpuSystemPercent: 6,
  activeResources: 7,
  ...over,
});

describe("runtimeCharts", () => {
  it("makes one column per series, x in seconds, and keeps null as a gap", () => {
    const c = runtimeCharts([
      sample({}),
      sample({
        timeUnixMs: 20_000,
        eventLoopP99Ms: null,
        activeResources: null,
      }),
    ]);
    expect(c.xs).toEqual([10, 20]);
    expect(c.eventLoop.map((s) => s.label)).toEqual(["p50", "p99", "max"]);
    expect(c.eventLoop[1]?.values).toEqual([2, null]);
    expect(c.memory.map((s) => s.values[0])).toEqual([10, 20, 30, 4]);
    expect(c.cpu.map((s) => s.values)).toEqual([
      [5, 5],
      [6, 6],
    ]);
    expect(c.resources[0]?.values).toEqual([7, null]);
  });

  it("is empty for no samples", () => {
    expect(runtimeCharts([]).xs).toEqual([]);
  });
});

describe("thresholds", () => {
  it("rates the event loop p99 at 20 ms and 50 ms", () => {
    expect(loopLevel(4.5)).toBe("ok");
    expect(loopLevel(19.9)).toBe("ok");
    expect(loopLevel(20)).toBe("watch");
    expect(loopLevel(49.9)).toBe("watch");
    expect(loopLevel(85)).toBe("high");
  });

  it("rates CPU at 60% and 85% of a core", () => {
    expect(cpuLevel(15)).toBe("ok");
    expect(cpuLevel(60)).toBe("watch");
    expect(cpuLevel(85)).toBe("high");
    expect(cpuLevel(140)).toBe("high");
  });

  it("rates the heap in use against what V8 allocated at 75% and 90%", () => {
    expect(heapLevel(40, 60)).toBe("ok");
    expect(heapLevel(45, 60)).toBe("watch");
    expect(heapLevel(55, 60)).toBe("high");
    expect(heapLevel(10, 0)).toBe("ok");
  });

  it("drops the gaps of a column", () => {
    expect(present([1, null, 3])).toEqual([1, 3]);
    expect(present([])).toEqual([]);
  });
});

describe("formatters", () => {
  it("formats memory, percent and uptime", () => {
    expect(formatMemory(512)).toBe("512 B");
    expect(formatMemory(812_000)).toBe("812 KB");
    expect(formatMemory(54_300_000)).toBe("54.3 MB");
    expect(formatMemory(1_200_000_000)).toBe("1.20 GB");
    expect(formatMemoryAxis(54_300_000)).toBe("54.3 MB");
    expect(formatMemoryAxis(120_400_000)).toBe("120 MB");
    expect(formatMemoryAxis(1_200_000_000)).toBe("1.20 GB");
    expect(formatPercent(3.2)).toBe("3.2%");
    expect(formatPercent(42.4)).toBe("42%");
    expect(formatUptime(45)).toBe("45 s");
    expect(formatUptime(720)).toBe("12 min");
    expect(formatUptime(12_600)).toBe("3.5 h");
    expect(formatUptime(181_440)).toBe("2.1 d");
  });
});
