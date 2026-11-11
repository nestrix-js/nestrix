/**
 * On-demand CPU profiler of the embedded dashboard (`/api/v1/profiles`, docs/backlog/phase-7.md
 * P7-02, D-70). Types only: this file adds no runtime export.
 *
 * Routes, under the dashboard path, registered only where `MetaResponse.profiler.available` is
 * true (the standalone server has none):
 * - `POST api/v1/profiles` with `ProfileStartRequest` as JSON: starts a capture. `202` with
 *   `ProfileStartResponse`; `409` with `ProfileConflictError` while one runs in the process; `429` with
 *   `ProfileCooldownError` and `Retry-After` within 10 s of the previous capture's end.
 *   Besides dashboard access it needs `Sec-Fetch-Site: same-origin`, an `Origin` equal to the
 *   request's own origin, `Content-Type: application/json` and a `Content-Length` of at most
 *   1,024 bytes (`403`, `415`, `411`, `413` otherwise; architecture §4.7).
 * - `GET api/v1/profiles`: `ProfileListResponse`.
 * - `GET api/v1/profiles/<id>`: `ProfileDetail`.
 * - `GET api/v1/profiles/<id>/download`: the `.cpuprofile` (Chrome DevTools format) as an
 *   attachment.
 */
import type { ApiError } from "./types.js";

/** Bounds of a capture (backlog phase 7, "Settled design"). */
export interface ProfileLimits {
  /** Used when `durationSeconds` is left out: 30. */
  defaultDurationSeconds: number;
  /** The longest capture: 120. */
  maxDurationSeconds: number;
  /** Profiles kept in memory; the oldest is dropped first: 3. */
  kept: number;
}

/** `POST api/v1/profiles`. Unknown fields are refused (400). Bounds: `profileStartBody`. */
export interface ProfileStartRequest {
  /** Whole seconds, 1 to 120. Default 30. */
  durationSeconds?: number;
}

/** The capture that is running now. */
export interface ProfileRunning {
  /** 16 lowercase hex characters. */
  id: string;
  startedAtUnixMs: number;
  /** Requested length. */
  durationMs: number;
  /** When the capture stops by itself. */
  endsAtUnixMs: number;
  /** How long starting it blocked the main thread (V8 logs existing code), measured. */
  startPauseMs: number;
}

/** `202` answer to `POST api/v1/profiles`. */
export type ProfileStartResponse = ProfileRunning;

/** `409` answer: a capture is already running in this process. */
export interface ProfileConflictError extends ApiError {
  /** The running capture; `null` when another copy of Nestrix started it and it is not readable. */
  running: ProfileRunning | null;
}

/** `429` answer (with a `Retry-After` header): the previous capture ended less than 10 s ago. */
export interface ProfileCooldownError extends ApiError {
  /** Whole seconds until a capture may start. */
  retryAfterSeconds: number;
}

/** One finished capture. */
export interface ProfileSummary {
  id: string;
  startedAtUnixMs: number;
  /** Requested length. */
  durationMs: number;
  /** Profile end minus profile start, as V8 measured it. */
  actualDurationMs: number;
  startPauseMs: number;
  /** Number of samples (stacks recorded). */
  samples: number;
  /** Size of the downloadable `.cpuprofile`. */
  bytes: number;
}

/** A function, merged over every call path, by self time. */
export interface ProfileFunction {
  /** `(anonymous)` for an unnamed function; V8's `(program)` and `(garbage collector)` as they are. */
  functionName: string;
  /** `file://` URL, `node:` id, or empty for V8's own entries. */
  url: string;
  /** 1-based line of the running JavaScript (no source maps); 0 when unknown. */
  line: number;
  /** 1-based column; 0 when unknown. */
  column: number;
  /** Samples with this function on top of the stack. */
  selfSamples: number;
  /** Samples with this function anywhere on the stack (a recursive call counted once). */
  totalSamples: number;
}

/** A node of the flame graph: V8's call tree, small subtrees pruned. */
export interface FlameNode {
  functionName: string;
  url: string;
  line: number;
  selfSamples: number;
  totalSamples: number;
  children: FlameNode[];
}

/** `GET api/v1/profiles/<id>`. */
export interface ProfileDetail extends ProfileSummary {
  /** Highest self time first, at most 50; `(idle)` and `(root)` left out. */
  topFunctions: ProfileFunction[];
  /**
   * Rooted at V8's `(root)`, whose `totalSamples` excludes `(idle)`; `(idle)` left out; children
   * narrower than 0.5% of the samples and nodes deeper than 128 pruned.
   */
  flame: FlameNode;
}

/** `GET api/v1/profiles`. */
export interface ProfileListResponse {
  running: ProfileRunning | null;
  /** Newest first, at most `limits.kept`. */
  profiles: ProfileSummary[];
  /** The last capture that failed, if any since the process started. */
  lastError: { atUnixMs: number; message: string } | null;
  /** The measured start pause of the latest capture in this process; `null` before the first. */
  lastStartPauseMs: number | null;
  limits: ProfileLimits;
}

/** `MetaResponse.profiler`. */
export interface MetaProfiler {
  /**
   * Whether the profiler routes exist: the embedded dashboard with `ui.profiler` not `false` and
   * authenticated (`ui.enabled: true` with `auth`, or `'auto'` with the startup token or `auth`).
   * Always `false` in the standalone server.
   */
  available: boolean;
  /** A capture is running in this process. */
  running: boolean;
}
