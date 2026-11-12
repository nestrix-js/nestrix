/**
 * Dependencies and request timeline (`GET api/v1/dependencies`, `GET api/v1/traces/timeline`,
 * docs/backlog/phase-9.md P9-05). Types only: this file adds no runtime export.
 *
 * Both are built from the stored, sampled traces, not counted before sampling.
 */
import type { MapNodeKind } from "./types.js";

/** One bucket of a dependency's series: 1 minute for a 15-minute window, 5 minutes for 60. */
export interface DependencyPoint {
  startUnixMs: number;
  calls: number;
  /** 0 when there were no calls in the bucket. */
  p95Ms: number;
}

/** An outbound target, classified as the app map does (`MapNode`). */
export interface DependencyStats {
  /** The map node id, e.g. `db:postgresql:localhost:5432/shop`. */
  id: string;
  kind: MapNodeKind;
  name: string;
  /** `db.system.name`, `messaging.system`, or `http`. */
  system?: string;
  calls: number;
  errors: number;
  /** `errors / calls`, a fraction. */
  errorRate: number;
  /** Sum of the calls' durations. */
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  /** The trace of the slowest call in the window, to open from the list. */
  exampleTraceId?: string;
  /** One point per bucket of the window, oldest first. */
  series: DependencyPoint[];
}

/** `GET api/v1/dependencies`: targets by total time, most first. */
export interface DependenciesResponse {
  windowMinutes: number;
  fromUnixMs: number;
  toUnixMs: number;
  bucketMs: number;
  dependencies: DependencyStats[];
}

/** One bucket of the request timeline: sampled traces by outcome of their root. */
export interface TimelineBucket {
  startUnixMs: number;
  ok: number;
  /** Root status 400 to 499 and not an error. */
  clientError: number;
  /** Root error, or status 500 and above. */
  serverError: number;
}

/** `GET api/v1/traces/timeline`. */
export interface TraceTimelineResponse {
  windowMinutes: number;
  fromUnixMs: number;
  toUnixMs: number;
  bucketMs: number;
  buckets: TimelineBucket[];
}
