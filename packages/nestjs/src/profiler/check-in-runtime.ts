/**
 * The runtime figures a remote-profiling check-in carries (P15-03, D-80; wire type
 * `InstanceRuntimeSample` in `packages/protocol/src/remote-profiles.ts`).
 *
 * Read once per check-in (every 15 s by default), on the poller's own timer: no timer, interval or
 * histogram of its own.
 *
 * - `cpuPercent`: `process.cpuUsage()` against the previous read (or `start()`), over the wall
 *   time between them, as a percentage of one core. Same formula as the embedded runtime view.
 * - `heapUsedBytes`, `rssBytes`: `process.memoryUsage()` now.
 * - `eventLoopP99Ms`: only from the embedded dashboard's runtime sampler (`dashboard/runtime.ts`)
 *   when it runs in this process and its latest sample is at most 30 s old. An event-loop-delay
 *   histogram for the check-in alone was measured (Node 26.13, idle process, 10 s): about 1.1 ms
 *   of CPU per second and ~47 wake-ups per second at the 20 ms resolution the SDK uses, five times
 *   the idle baseline. That is measurable, so the check-in does without it.
 *
 * Each source has its own guard; a failure is counted and the other figures still report. Nothing
 * here throws (rule 1).
 */
import type {
  InstanceRuntimeSample,
  RuntimeSample,
} from "@nestrix-js/protocol";
import type { Diagnostics } from "../diagnostics.js";

/** A dashboard sample older than this is not used for `eventLoopP99Ms`. */
export const LOOP_SAMPLE_MAX_AGE_MS = 30_000;

/** What the reader takes from the process; tests replace it. */
export interface CheckInRuntimeSources {
  /** Wall clock, for `sampledAtUnixMs`. */
  now(): number;
  /** Monotonic clock in ms, for the CPU interval (immune to wall-clock steps). Defaults to `now`. */
  monotonic?(): number;
  cpuUsage(): { user: number; system: number };
  memoryUsage(): { heapUsed: number; rss: number };
}

const processSources: CheckInRuntimeSources = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  cpuUsage: () => process.cpuUsage(),
  memoryUsage: () => process.memoryUsage(),
};

/** The part of the reader the poller uses (a seam for fault injection). */
export interface CheckInRuntimeReader {
  /** Takes the CPU baseline. Never throws. */
  start(): void;
  /** The figures now, or `undefined` when none could be read. Never throws. */
  read(): InstanceRuntimeSample | undefined;
}

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export class CheckInRuntime implements CheckInRuntimeReader {
  private lastCpu: { user: number; system: number } | undefined;
  private lastAt = 0;

  constructor(
    private readonly diagnostics: Diagnostics,
    /** The embedded dashboard's latest sample while its sampler runs; `null` otherwise. */
    private readonly latestDashboardSample?: () => RuntimeSample | null,
    private readonly sources: CheckInRuntimeSources = processSources,
  ) {}

  /** The interval clock: monotonic when the source has one, so a wall-clock step cannot skew CPU %. */
  private tick(): number {
    return this.sources.monotonic
      ? this.sources.monotonic()
      : this.sources.now();
  }

  start(): void {
    try {
      this.lastCpu = this.sources.cpuUsage();
      this.lastAt = this.tick();
    } catch (error) {
      this.lastCpu = undefined;
      this.diagnostics.countFailure("profiler.remote.runtime", error);
    }
  }

  read(): InstanceRuntimeSample | undefined {
    try {
      const now = this.sources.now();
      if (!finiteNonNegative(now) || now === 0) return undefined;
      const sample: InstanceRuntimeSample = {
        sampledAtUnixMs: Math.round(now),
      };
      let any = false;
      try {
        const cpu = this.sources.cpuUsage();
        const at = this.tick();
        const elapsedMicros = (at - this.lastAt) * 1000;
        if (this.lastCpu !== undefined && elapsedMicros > 0) {
          const used =
            cpu.user - this.lastCpu.user + (cpu.system - this.lastCpu.system);
          const percent = Math.round((used / elapsedMicros) * 10_000) / 100;
          if (Number.isFinite(percent)) {
            sample.cpuPercent = Math.max(0, percent);
            any = true;
          }
        }
        this.lastCpu = cpu;
        this.lastAt = at;
      } catch (error) {
        this.diagnostics.countFailure("profiler.remote.runtime", error);
      }
      try {
        const memory = this.sources.memoryUsage();
        if (finiteNonNegative(memory.heapUsed)) {
          sample.heapUsedBytes = memory.heapUsed;
          any = true;
        }
        if (finiteNonNegative(memory.rss)) {
          sample.rssBytes = memory.rss;
          any = true;
        }
      } catch (error) {
        this.diagnostics.countFailure("profiler.remote.runtime", error);
      }
      try {
        const latest = this.latestDashboardSample?.() ?? null;
        if (
          latest !== null &&
          finiteNonNegative(latest.eventLoopP99Ms) &&
          now - latest.timeUnixMs <= LOOP_SAMPLE_MAX_AGE_MS
        ) {
          sample.eventLoopP99Ms = latest.eventLoopP99Ms;
          any = true;
        }
      } catch (error) {
        this.diagnostics.countFailure("profiler.remote.runtime", error);
      }
      return any ? sample : undefined;
    } catch (error) {
      this.diagnostics.countFailure("profiler.remote.runtime", error);
      return undefined;
    }
  }
}
