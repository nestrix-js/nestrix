// P15-03: the check-in's runtime figures (src/profiler/check-in-runtime.ts) with fake sources, and
// the dashboard sampler's `latest()` that feeds its event-loop p99.
import type { RuntimeSample } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";
import { RuntimeSampler } from "../src/dashboard/runtime.js";
import {
  CheckInRuntime,
  type CheckInRuntimeSources,
  LOOP_SAMPLE_MAX_AGE_MS,
} from "../src/profiler/check-in-runtime.js";
import { recordingDiagnostics } from "./otel-helpers.js";

function fakeSources(over: Partial<CheckInRuntimeSources> = {}) {
  const state = {
    now: 1_000_000,
    cpu: { user: 0, system: 0 },
    memory: { heapUsed: 10_000_000, rss: 50_000_000 },
  };
  const sources: CheckInRuntimeSources = {
    now: () => state.now,
    cpuUsage: () => ({ ...state.cpu }),
    memoryUsage: () => ({ ...state.memory }),
    ...over,
  };
  return { state, sources };
}

const dashboardSample = (
  timeUnixMs: number,
  p99: number | null,
): RuntimeSample => ({
  timeUnixMs,
  eventLoopP50Ms: 1,
  eventLoopP99Ms: p99,
  eventLoopMaxMs: 9,
  heapUsedBytes: 1,
  heapTotalBytes: 1,
  rssBytes: 1,
  externalBytes: 1,
  cpuUserPercent: 1,
  cpuSystemPercent: 1,
  activeResources: 1,
});

describe("CheckInRuntime", () => {
  it("CPU is user + system over the wall time since the previous read, % of one core", () => {
    const { state, sources } = fakeSources();
    const reader = new CheckInRuntime(
      recordingDiagnostics(),
      undefined,
      sources,
    );
    reader.start();
    state.now += 10_000; // 10 s
    state.cpu = { user: 2_000_000, system: 500_000 }; // 2.5 s of CPU
    expect(reader.read()).toEqual({
      sampledAtUnixMs: 1_010_000,
      cpuPercent: 25,
      heapUsedBytes: 10_000_000,
      rssBytes: 50_000_000,
    });
    // The next figure covers only the next interval.
    state.now += 5_000;
    state.cpu = { user: 2_000_000 + 7_500_000, system: 500_000 }; // 7.5 s in 5 s: 150%
    expect(reader.read()?.cpuPercent).toBe(150);
  });

  it("without start() the first read has no CPU figure; a clock that does not move gives none", () => {
    const { state, sources } = fakeSources();
    const reader = new CheckInRuntime(
      recordingDiagnostics(),
      undefined,
      sources,
    );
    expect(reader.read()?.cpuPercent).toBeUndefined();
    expect(reader.read()?.cpuPercent).toBeUndefined(); // same `now`: elapsed 0
    state.now += 1000;
    expect(reader.read()?.cpuPercent).toBe(0);
  });

  it("a CPU counter that goes backwards reports 0, not a negative figure", () => {
    const { state, sources } = fakeSources();
    state.cpu = { user: 5_000_000, system: 0 };
    const reader = new CheckInRuntime(
      recordingDiagnostics(),
      undefined,
      sources,
    );
    reader.start();
    state.now += 1000;
    state.cpu = { user: 0, system: 0 };
    expect(reader.read()?.cpuPercent).toBe(0);
  });

  it("drops non-finite or negative memory figures", () => {
    const { state, sources } = fakeSources();
    state.memory = { heapUsed: Number.NaN, rss: -1 };
    const reader = new CheckInRuntime(
      recordingDiagnostics(),
      undefined,
      sources,
    );
    reader.start();
    state.now += 1000;
    expect(reader.read()).toEqual({
      sampledAtUnixMs: 1_001_000,
      cpuPercent: 0,
    });
  });

  it("event-loop p99 from a fresh dashboard sample only, and never a null one", () => {
    const { state, sources } = fakeSources();
    let latest: RuntimeSample | null = null;
    const reader = new CheckInRuntime(
      recordingDiagnostics(),
      () => latest,
      sources,
    );
    expect(reader.read()?.eventLoopP99Ms).toBeUndefined();
    latest = dashboardSample(state.now - LOOP_SAMPLE_MAX_AGE_MS, 12.25);
    expect(reader.read()?.eventLoopP99Ms).toBe(12.25);
    latest = dashboardSample(state.now - LOOP_SAMPLE_MAX_AGE_MS - 1, 12.25);
    expect(reader.read()?.eventLoopP99Ms).toBeUndefined();
    latest = dashboardSample(state.now, null);
    expect(reader.read()?.eventLoopP99Ms).toBeUndefined();
  });

  it("fault injection: every source throwing gives undefined and counts each failure", () => {
    const diagnostics = recordingDiagnostics();
    const boom = () => {
      throw new Error("boom");
    };
    const { sources } = fakeSources({ cpuUsage: boom, memoryUsage: boom });
    const reader = new CheckInRuntime(diagnostics, boom, sources);
    expect(() => reader.start()).not.toThrow();
    expect(reader.read()).toBeUndefined();
    expect(
      diagnostics.failures
        .map((f) => f.where)
        .filter((w) => w === "profiler.remote.runtime"),
    ).toHaveLength(4); // start, cpu, memory, dashboard
  });

  it("fault injection: a throwing clock gives undefined, never a throw", () => {
    const diagnostics = recordingDiagnostics();
    const { sources } = fakeSources({
      now: () => {
        throw new Error("clock");
      },
    });
    const reader = new CheckInRuntime(diagnostics, undefined, sources);
    expect(() => reader.start()).not.toThrow();
    expect(reader.read()).toBeUndefined();
    expect(diagnostics.failures.length).toBe(2);
  });

  it("one failing source leaves the others reporting", () => {
    const { state, sources } = fakeSources({
      memoryUsage: () => {
        throw new Error("memory");
      },
    });
    const reader = new CheckInRuntime(
      recordingDiagnostics(),
      undefined,
      sources,
    );
    reader.start();
    state.now += 2000;
    state.cpu = { user: 1_000_000, system: 0 };
    expect(reader.read()).toEqual({
      sampledAtUnixMs: 1_002_000,
      cpuPercent: 50,
    });
  });
});

describe("RuntimeSampler.latest()", () => {
  it("is null before start, the newest sample while running, null after stop", () => {
    let now = 5_000;
    const sampler = new RuntimeSampler(recordingDiagnostics(), {
      now: () => now,
      cpuUsage: () => ({ user: 0, system: 0 }),
      memoryUsage: () => ({ heapUsed: 1, heapTotal: 2, rss: 3, external: 4 }),
      activeResources: () => 1,
      histogram: () => ({
        count: 1,
        max: 2e6,
        percentile: () => 1e6,
        enable() {},
        disable() {},
        reset() {},
      }),
    });
    expect(sampler.latest()).toBeNull();
    sampler.start();
    expect(sampler.latest()).toBeNull();
    now += 10_000;
    sampler.sample();
    expect(sampler.latest()?.timeUnixMs).toBe(15_000);
    expect(sampler.latest()?.eventLoopP99Ms).toBe(1);
    sampler.stop();
    expect(sampler.latest()).toBeNull();
  });
});
