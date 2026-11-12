import type { RuntimeSample } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  formatMemory,
  formatPercent,
  formatUptime,
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

describe("formatters", () => {
  it("formats memory, percent and uptime", () => {
    expect(formatMemory(512)).toBe("512 B");
    expect(formatMemory(812_000)).toBe("812 KB");
    expect(formatMemory(54_300_000)).toBe("54.3 MB");
    expect(formatMemory(1_200_000_000)).toBe("1.20 GB");
    expect(formatPercent(3.2)).toBe("3.2%");
    expect(formatPercent(42.4)).toBe("42%");
    expect(formatUptime(45)).toBe("45 s");
    expect(formatUptime(720)).toBe("12 min");
    expect(formatUptime(12_600)).toBe("3.5 h");
    expect(formatUptime(181_440)).toBe("2.1 d");
  });
});
