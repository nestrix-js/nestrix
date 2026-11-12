import type {
  InstanceRuntimeSample,
  InstanceSummary,
} from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  columnMax,
  formatCpu,
  formatRuntimeBytes,
  instanceKey,
  NO_FIGURE,
  suggestInstances,
  suggestionTitle,
} from "@/views/profiler/instance-runtime";

function instance(
  id: string,
  sample: Partial<InstanceRuntimeSample> | null | undefined,
  service = "orders",
): InstanceSummary {
  const base: InstanceSummary = {
    service,
    instanceId: id,
    version: null,
    host: null,
    pid: null,
    runtime: null,
    sdkVersion: null,
    firstSeenUnixMs: 0,
    lastSeenUnixMs: 0,
    capture: null,
  };
  if (sample === undefined) return base; // an older server: no field at all
  return {
    ...base,
    runtimeSample: sample === null ? null : { sampledAtUnixMs: 1, ...sample },
  };
}

const suggested = (list: InstanceSummary[]) =>
  [...suggestInstances(list).values()].map((s) => [
    s.service,
    s.instanceId,
    s.reason,
  ]);

describe("suggestInstances", () => {
  it("suggests the clear CPU leader", () => {
    const list = [
      instance("a", { cpuPercent: 12 }),
      instance("b", { cpuPercent: 64 }),
      instance("c", { cpuPercent: 20 }),
    ];
    expect(suggested(list)).toEqual([["orders", "b", "cpu"]]);
    const s = suggestInstances(list).get(
      instanceKey(list[1] as InstanceSummary),
    );
    expect(s).toMatchObject({ value: 64, runnerUp: 20 });
  });

  it("needs at least two instances reporting the figure", () => {
    expect(suggested([instance("a", { cpuPercent: 90 })])).toEqual([]);
    expect(
      suggested([
        instance("a", { cpuPercent: 90 }),
        instance("b", null),
        instance("c", undefined),
      ]),
    ).toEqual([]);
  });

  it("both thresholds must hold: 1.5x and 10 points for CPU", () => {
    // 1.5x but only 0.6 points apart: idle instances.
    expect(
      suggested([
        instance("a", { cpuPercent: 1 }),
        instance("b", { cpuPercent: 0.4 }),
      ]),
    ).toEqual([]);
    // 10 points apart but under 1.5x: both busy.
    expect(
      suggested([
        instance("a", { cpuPercent: 80 }),
        instance("b", { cpuPercent: 70 }),
      ]),
    ).toEqual([]);
    // Exactly on both thresholds counts.
    expect(
      suggested([
        instance("a", { cpuPercent: 30 }),
        instance("b", { cpuPercent: 20 }),
      ]),
    ).toEqual([["orders", "a", "cpu"]]);
  });

  it("falls back to event-loop p99 (1.5x and 20 ms) when CPU has no clear leader", () => {
    const list = [
      instance("a", { cpuPercent: 40, eventLoopP99Ms: 25 }),
      instance("b", { cpuPercent: 42, eventLoopP99Ms: 180 }),
    ];
    expect(suggested(list)).toEqual([["orders", "b", "loop"]]);
    expect(
      suggested([
        instance("a", { eventLoopP99Ms: 25 }),
        instance("b", { eventLoopP99Ms: 44 }),
      ]),
    ).toEqual([]); // 1.76x but 19 ms apart
  });

  it("CPU wins over the loop when both have a clear leader", () => {
    expect(
      suggested([
        instance("a", { cpuPercent: 90, eventLoopP99Ms: 20 }),
        instance("b", { cpuPercent: 10, eventLoopP99Ms: 300 }),
      ]),
    ).toEqual([["orders", "a", "cpu"]]);
  });

  it("compares only within a service: one suggestion per service at most", () => {
    const list = [
      instance("a", { cpuPercent: 90 }, "orders"),
      instance("b", { cpuPercent: 5 }, "billing"),
      instance("c", { cpuPercent: 2 }, "billing"),
      instance("d", { cpuPercent: 80 }, "billing"),
    ];
    expect(suggested(list)).toEqual([["billing", "d", "cpu"]]);
  });

  it("an equal top pair, or no runtime anywhere, gives nothing", () => {
    expect(
      suggested([
        instance("a", { cpuPercent: 50 }),
        instance("b", { cpuPercent: 50 }),
      ]),
    ).toEqual([]);
    expect(suggested([instance("a", undefined), instance("b", null)])).toEqual(
      [],
    );
    expect(suggested([])).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats CPU, bytes and the absent figure", () => {
    expect(formatCpu(0.42)).toBe("0.4%");
    expect(formatCpu(37.25)).toBe("37%");
    expect(formatCpu(140)).toBe("140%");
    expect(formatRuntimeBytes(48_000_000)).toBe("48.0 MB");
    expect(formatRuntimeBytes(undefined)).toBe(NO_FIGURE);
    expect(NO_FIGURE).toBe("—");
  });

  it("the tooltip names the figure and both values", () => {
    expect(
      suggestionTitle({
        service: "orders",
        instanceId: "b",
        reason: "cpu",
        value: 64,
        runnerUp: 20,
      }),
    ).toContain("64% of a core against 20%");
    expect(
      suggestionTitle({
        service: "orders",
        instanceId: "b",
        reason: "loop",
        value: 180,
        runnerUp: 25,
      }),
    ).toContain("180 ms against 25 ms");
  });

  it("columnMax takes the largest finite figure, at least the floor", () => {
    const list = [
      instance("a", { cpuPercent: 140 }),
      instance("b", { cpuPercent: 20 }),
      instance("c", null),
    ];
    expect(columnMax(list, (i) => i.runtimeSample?.cpuPercent, 100)).toBe(140);
    expect(
      columnMax(list.slice(1), (i) => i.runtimeSample?.cpuPercent, 100),
    ).toBe(100);
  });
});
