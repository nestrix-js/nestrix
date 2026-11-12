// P9-06: the runtime sampler with a fake clock and fake process readings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DelayHistogram,
  RUNTIME_INTERVAL_MS,
  RuntimeSampler,
  type RuntimeSources,
  runtimeHandler,
} from "../src/dashboard/runtime.js";
import {
  diagnostics,
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";

class FakeHistogram implements DelayHistogram {
  count = 0;
  max = 0;
  enabled = false;
  resets = 0;
  percentile(p: number): number {
    return p === 50 ? 2_000_000 : 9_000_000; // ns
  }
  enable() {
    this.enabled = true;
  }
  disable() {
    this.enabled = false;
  }
  reset() {
    this.resets++;
    this.count = 0;
    this.max = 0;
  }
}

let clock = 0;
let cpu = { user: 0, system: 0 };
let histogram: FakeHistogram;
let sources: RuntimeSources;

beforeEach(() => {
  vi.useFakeTimers();
  resetDiagnosticsForTests();
  clock = 1_000_000;
  cpu = { user: 0, system: 0 };
  histogram = new FakeHistogram();
  sources = {
    now: () => clock,
    cpuUsage: () => ({ ...cpu }),
    memoryUsage: () => ({
      heapUsed: 10,
      heapTotal: 20,
      rss: 30,
      external: 4,
    }),
    activeResources: () => 7,
    histogram: () => histogram,
  };
});
afterEach(() => {
  vi.useRealTimers();
});

/** Advances the fake wall clock and the fake timers together, one interval at a time. */
function tick(ms: number): void {
  for (let left = ms; left > 0; left -= RUNTIME_INTERVAL_MS) {
    clock += RUNTIME_INTERVAL_MS;
    vi.advanceTimersByTime(RUNTIME_INTERVAL_MS);
  }
}

describe("RuntimeSampler", () => {
  it("samples every 10 s: event loop in ms, memory, CPU percent from deltas, and resets the histogram", () => {
    const sampler = new RuntimeSampler(diagnostics, sources);
    sampler.start();
    expect(histogram.enabled).toBe(true);
    expect(sampler.snapshot().samples).toEqual([]);

    histogram.count = 5;
    histogram.max = 50_000_000;
    cpu = { user: 1_000_000, system: 500_000 }; // 1 s and 0.5 s of CPU in 10 s
    tick(RUNTIME_INTERVAL_MS);

    const snap = sampler.snapshot();
    expect(snap.samples).toHaveLength(1);
    expect(snap.samples[0]).toEqual({
      timeUnixMs: 1_010_000,
      eventLoopP50Ms: 2,
      eventLoopP99Ms: 9,
      eventLoopMaxMs: 50,
      heapUsedBytes: 10,
      heapTotalBytes: 20,
      rssBytes: 30,
      externalBytes: 4,
      cpuUserPercent: 10,
      cpuSystemPercent: 5,
      activeResources: 7,
    });
    expect(snap.current).toEqual(snap.samples[0]);
    expect(histogram.resets).toBe(1);

    // An interval with no event-loop samples reports null, not zero; CPU is a delta again.
    cpu = { user: 1_000_000 + 2_000_000, system: 500_000 };
    tick(RUNTIME_INTERVAL_MS);
    const second = sampler.snapshot().samples[1];
    expect(second?.eventLoopP50Ms).toBeNull();
    expect(second?.cpuUserPercent).toBe(20);
    expect(second?.cpuSystemPercent).toBe(0);
    sampler.stop();
  });

  it("keeps 60 minutes (360 samples), oldest dropped first", () => {
    const sampler = new RuntimeSampler(diagnostics, sources);
    sampler.start();
    tick(RUNTIME_INTERVAL_MS * 365);
    const { samples } = sampler.snapshot();
    expect(samples).toHaveLength(360);
    expect(samples[0]?.timeUnixMs).toBe(1_000_000 + 6 * RUNTIME_INTERVAL_MS);
    expect(samples.at(-1)?.timeUnixMs).toBe(
      1_000_000 + 365 * RUNTIME_INTERVAL_MS,
    );
    sampler.stop();
  });

  it("stop() ends the timer and the histogram; start() twice runs one timer", () => {
    const sampler = new RuntimeSampler(diagnostics, sources);
    sampler.start();
    sampler.start();
    tick(RUNTIME_INTERVAL_MS);
    expect(sampler.snapshot().samples).toHaveLength(1);
    sampler.stop();
    expect(histogram.enabled).toBe(false);
    tick(RUNTIME_INTERVAL_MS * 3);
    expect(sampler.snapshot().samples).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the timer is unref'd, so it never keeps the process alive", () => {
    const unref = vi.fn();
    const real = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      const t = real(fn, ms);
      t.unref = (() => {
        unref();
        return t;
      }) as typeof t.unref;
      return t;
    }) as typeof setInterval);
    const sampler = new RuntimeSampler(diagnostics, sources);
    sampler.start();
    expect(unref).toHaveBeenCalledTimes(1);
    sampler.stop();
    spy.mockRestore();
  });

  it("never throws: a failing source is counted and the others still report", () => {
    sources.memoryUsage = () => {
      throw new Error("no memory");
    };
    sources.cpuUsage = () => {
      throw new Error("no cpu");
    };
    histogram.percentile = () => {
      throw new Error("no histogram");
    };
    histogram.count = 1;
    const sampler = new RuntimeSampler(diagnostics, sources);
    expect(() => sampler.start()).not.toThrow();
    expect(() => tick(RUNTIME_INTERVAL_MS)).not.toThrow();
    const sample = sampler.snapshot().samples[0];
    expect(sample?.activeResources).toBe(7);
    expect(sample?.eventLoopP50Ms).toBeNull();
    expect(sample?.cpuUserPercent).toBe(0);
    const counts = getFailureCounts();
    expect(counts.get("dashboard.runtime.memory")).toBe(1);
    expect(counts.get("dashboard.runtime.eventloop")).toBe(1);
    expect(counts.get("dashboard.runtime.cpu")).toBeGreaterThanOrEqual(1);
    sampler.stop();
  });

  it("a histogram that cannot start leaves the rest working", () => {
    sources.histogram = () => {
      throw new Error("unsupported");
    };
    const sampler = new RuntimeSampler(diagnostics, sources);
    sampler.start();
    tick(RUNTIME_INTERVAL_MS);
    expect(sampler.snapshot().samples).toHaveLength(1);
    expect(sampler.snapshot().samples[0]?.rssBytes).toBe(30);
    sampler.stop();
  });

  it("the real sources produce a sensible sample", () => {
    vi.useRealTimers();
    const sampler = new RuntimeSampler(diagnostics);
    sampler.start();
    sampler.sample();
    const sample = sampler.snapshot().current;
    sampler.stop();
    expect(sample?.rssBytes).toBeGreaterThan(0);
    expect(sample?.heapUsedBytes).toBeGreaterThan(0);
    expect(sample?.cpuUserPercent).toBeGreaterThanOrEqual(0);
    expect(getFailureCounts().size).toBe(0);
  });
});

describe("runtimeHandler", () => {
  it("answers the series, current values, uptime and Node version; 400 on a query parameter", () => {
    const sampler = new RuntimeSampler(diagnostics, sources);
    sampler.start();
    tick(RUNTIME_INTERVAL_MS);
    const r = runtimeHandler("/_nestrix/api/v1/runtime", sampler);
    expect(r.status).toBe(200);
    const body = JSON.parse(String(r.body));
    expect(body).toMatchObject({
      intervalMs: 10_000,
      retentionMinutes: 60,
      process: { nodeVersion: process.version },
    });
    expect(body.samples).toHaveLength(1);
    expect(body.current).toEqual(body.samples[0]);
    expect(typeof body.process.uptimeSeconds).toBe("number");
    expect(runtimeHandler("/x?limit=5", sampler).status).toBe(400);
    sampler.stop();
  });
});
