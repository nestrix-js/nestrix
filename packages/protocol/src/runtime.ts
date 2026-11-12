/**
 * Process runtime samples of the embedded dashboard (`GET api/v1/runtime`, docs/backlog/phase-9.md
 * P9-06). Types only: this file adds no runtime export.
 *
 * A small in-process sampler (every 10 s, while the dashboard is on, no MeterProvider needed)
 * keeps the last 60 minutes. These are process facts, not trace data: they are not sampled and
 * not derived from spans. The standalone server has no such data: `MetaResponse.runtime.available`
 * is `false` there and the route does not exist.
 */

/** `MetaResponse.runtime`. */
export interface MetaRuntime {
  /** Whether `GET api/v1/runtime` exists: the embedded dashboard only. */
  available: boolean;
}

/** One sample, covering the interval that ended at `timeUnixMs`. */
export interface RuntimeSample {
  timeUnixMs: number;
  /** Event loop delay percentiles over the interval, milliseconds; `null` when it recorded none. */
  eventLoopP50Ms: number | null;
  eventLoopP99Ms: number | null;
  eventLoopMaxMs: number | null;
  /** `process.memoryUsage()`, bytes. */
  heapUsedBytes: number;
  heapTotalBytes: number;
  rssBytes: number;
  externalBytes: number;
  /** CPU time used over the interval as a percentage of one core (may exceed 100 with threads). */
  cpuUserPercent: number;
  cpuSystemPercent: number;
  /** `process.getActiveResourcesInfo().length` (open handles and pending requests); `null` if unavailable. */
  activeResources: number | null;
}

export interface RuntimeResponse {
  /** Milliseconds between samples: 10,000. */
  intervalMs: number;
  /** How long samples are kept: 60. */
  retentionMinutes: number;
  /** Oldest first; empty until the first interval has passed. */
  samples: RuntimeSample[];
  /** The newest sample, or `null` before the first. */
  current: RuntimeSample | null;
  process: {
    uptimeSeconds: number;
    nodeVersion: string;
  };
}
