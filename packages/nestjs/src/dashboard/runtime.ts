/**
 * The runtime view's sampler and endpoint (P9-06). While the dashboard is mounted, a timer
 * (every 10 s, `unref`'d, cleared at shutdown) records one `RuntimeSample` and keeps the last 60
 * minutes. It reads `process` and an event-loop-delay histogram of its own, so it works with no
 * MeterProvider and nothing runs per request. Every read has its own guard: a failure is counted
 * and the other fields still report; nothing here throws to its caller.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { RuntimeResponse, RuntimeSample } from "@nestrix-js/protocol";
import type { Diagnostics } from "../diagnostics.js";
import { apiError, parseQuery } from "./api.js";
import { type DashboardResponse, JSON_TYPE } from "./respond.js";

export const RUNTIME_INTERVAL_MS = 10_000;
export const RUNTIME_RETENTION_MINUTES = 60;
const CAPACITY = (RUNTIME_RETENTION_MINUTES * 60_000) / RUNTIME_INTERVAL_MS;
/** `monitorEventLoopDelay` resolution; the same as the metrics module's. */
const EVENT_LOOP_RESOLUTION_MS = 20;

/** The slice of an event-loop-delay histogram the sampler uses (nanoseconds). */
export interface DelayHistogram {
  readonly count: number;
  readonly max: number;
  percentile(p: number): number;
  enable(): unknown;
  disable(): unknown;
  reset(): void;
}

/** Everything the sampler reads from the process; tests replace it. */
export interface RuntimeSources {
  now(): number;
  cpuUsage(): { user: number; system: number };
  memoryUsage(): {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
  };
  /** `undefined` when the runtime cannot say. */
  activeResources(): number | undefined;
  histogram(): DelayHistogram;
}

const processSources: RuntimeSources = {
  now: () => Date.now(),
  cpuUsage: () => process.cpuUsage(),
  memoryUsage: () => process.memoryUsage(),
  activeResources: () =>
    typeof process.getActiveResourcesInfo === "function"
      ? process.getActiveResourcesInfo().length
      : undefined,
  histogram: () =>
    monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS }),
};

const round = (value: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

export class RuntimeSampler {
  private readonly samples: RuntimeSample[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private histogram: DelayHistogram | undefined;
  private lastCpu: { user: number; system: number } | undefined;
  private lastAt = 0;

  constructor(
    private readonly diagnostics: Diagnostics,
    private readonly sources: RuntimeSources = processSources,
  ) {}

  /** Starts sampling; calling it again does nothing. Never throws. */
  start(): void {
    if (this.timer !== undefined) return;
    try {
      try {
        const histogram = this.sources.histogram();
        histogram.enable();
        this.histogram = histogram;
      } catch (error) {
        this.diagnostics.countFailure("dashboard.runtime.eventloop", error);
      }
      try {
        this.lastCpu = this.sources.cpuUsage();
      } catch (error) {
        this.diagnostics.countFailure("dashboard.runtime.cpu", error);
      }
      this.lastAt = this.sources.now();
      this.timer = setInterval(() => this.sample(), RUNTIME_INTERVAL_MS);
      this.timer.unref?.();
    } catch (error) {
      this.diagnostics.countFailure("dashboard.runtime.start", error);
    }
  }

  /** Stops the timer and the histogram; the samples stay readable. Never throws. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    try {
      this.histogram?.disable();
    } catch (error) {
      this.diagnostics.countFailure("dashboard.runtime.stop", error);
    }
    this.histogram = undefined;
  }

  /** Records one sample now. Called by the timer; public for tests. Never throws. */
  sample(): void {
    try {
      const now = this.sources.now();
      let p50: number | null = null;
      let p99: number | null = null;
      let max: number | null = null;
      try {
        const h = this.histogram;
        if (h !== undefined) {
          if (h.count > 0) {
            p50 = round(h.percentile(50) / 1e6, 3);
            p99 = round(h.percentile(99) / 1e6, 3);
            max = round(h.max / 1e6, 3);
          }
          h.reset();
        }
      } catch (error) {
        this.diagnostics.countFailure("dashboard.runtime.eventloop", error);
      }
      let user = 0;
      let system = 0;
      try {
        const cpu = this.sources.cpuUsage();
        const elapsedMicros = (now - this.lastAt) * 1000;
        if (this.lastCpu !== undefined && elapsedMicros > 0) {
          user = round(
            ((cpu.user - this.lastCpu.user) / elapsedMicros) * 100,
            2,
          );
          system = round(
            ((cpu.system - this.lastCpu.system) / elapsedMicros) * 100,
            2,
          );
        }
        this.lastCpu = cpu;
      } catch (error) {
        this.diagnostics.countFailure("dashboard.runtime.cpu", error);
      }
      this.lastAt = now;
      let memory = { heapUsed: 0, heapTotal: 0, rss: 0, external: 0 };
      try {
        memory = this.sources.memoryUsage();
      } catch (error) {
        this.diagnostics.countFailure("dashboard.runtime.memory", error);
      }
      let active: number | null = null;
      try {
        active = this.sources.activeResources() ?? null;
      } catch (error) {
        this.diagnostics.countFailure("dashboard.runtime.resources", error);
      }
      this.samples.push({
        timeUnixMs: now,
        eventLoopP50Ms: p50,
        eventLoopP99Ms: p99,
        eventLoopMaxMs: max,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        rssBytes: memory.rss,
        externalBytes: memory.external,
        cpuUserPercent: Math.max(0, user),
        cpuSystemPercent: Math.max(0, system),
        activeResources: active,
      });
      if (this.samples.length > CAPACITY) {
        this.samples.splice(0, this.samples.length - CAPACITY);
      }
    } catch (error) {
      this.diagnostics.countFailure("dashboard.runtime.sample", error);
    }
  }

  /**
   * The newest sample while the sampler runs; `null` before the first or once stopped. Read by the
   * remote-profiling check-in for its event-loop p99 (P15-03). Never throws.
   */
  latest(): RuntimeSample | null {
    if (this.timer === undefined) return null;
    return this.samples.at(-1) ?? null;
  }

  snapshot(): RuntimeResponse {
    const samples = [...this.samples];
    return {
      intervalMs: RUNTIME_INTERVAL_MS,
      retentionMinutes: RUNTIME_RETENTION_MINUTES,
      samples,
      current: samples.at(-1) ?? null,
      process: {
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
      },
    };
  }
}

/** `GET <path>/api/v1/runtime`: no query parameters. */
export function runtimeHandler(
  target: unknown,
  sampler: RuntimeSampler,
): DashboardResponse {
  const parsed = parseQuery(target, {});
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  return {
    status: 200,
    contentType: JSON_TYPE,
    body: JSON.stringify(sampler.snapshot()),
  };
}
