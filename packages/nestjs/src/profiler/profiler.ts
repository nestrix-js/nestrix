/**
 * On-demand CPU profiling (P7-02, D-70; spike P7-S1 "Chosen approach").
 *
 * - `v8.startCpuProfile({ sampleInterval: 1, maxBufferSize })`, with `node:v8` loaded through
 *   `process.getBuiltinModule` on the first capture only. Nothing is loaded or created before.
 * - One capture per process: the API does not refuse a second concurrent capture, so a
 *   process-wide slot (`globalThis[Symbol.for("nestrix.profiler")]`) is claimed for the length of
 *   a capture. Two copies of the package, or two Nestrix apps in one process, share it.
 * - The end timer is `unref()`'ed; the app that started a capture discards it at shutdown.
 * - After stop, off the request path (`setImmediate`), the profile is normalised and summarised
 *   once (`normalize.ts`) and kept as a string with its metadata; the last three are kept.
 * - Every call into V8 is guarded (rule 1). `startCpuProfile` can throw and `stop()` can return
 *   `undefined`; a failure frees the slot, is logged once and is shown in the dashboard.
 *
 * Nothing here throws to its caller.
 */
import { randomBytes } from "node:crypto";
import type {
  FlameNode,
  MetaProfiler,
  ProfileDetail,
  ProfileFunction,
  ProfileLimits,
  ProfileListResponse,
  ProfileRunning,
  ProfileSummary,
} from "@nestrix-js/protocol";
import {
  type Diagnostics,
  diagnostics as defaultDiagnostics,
} from "../diagnostics.js";
import { normalizeProfile } from "./normalize.js";

export const PROFILE_LIMITS: Readonly<ProfileLimits> = Object.freeze({
  defaultDurationSeconds: 30,
  maxDurationSeconds: 120,
  kept: 3,
});

/** Requested sampling interval, milliseconds (P7-S1: about 1.5 ms effective on macOS). */
export const SAMPLE_INTERVAL_MS = 1;

/**
 * A slot whose capture should have ended this long ago is taken to be abandoned (a package copy
 * that lost its timer) and may be reclaimed, so one fault cannot disable profiling for good.
 */
export const STALE_SLOT_GRACE_MS = 30_000;

/** A start within this long of the previous capture's end is refused (`cooldown`). */
export const COOLDOWN_MS = 10_000;

/** `maxBufferSize` for a capture of `durationMs`: one sample per interval, plus headroom. */
export function bufferSizeFor(durationMs: number): number {
  return Math.ceil(durationMs / SAMPLE_INTERVAL_MS) + 1000;
}

/** The handle `v8.startCpuProfile` returns. */
export interface CpuProfileHandleLike {
  stop(): string | undefined;
  [Symbol.dispose](): void;
}

/** The part of `node:v8` used here. */
export interface V8Like {
  startCpuProfile(options: {
    sampleInterval: number;
    maxBufferSize: number;
  }): CpuProfileHandleLike;
}

/** Seams for tests. Internal; not exported from the package entry. */
export const profilerRuntime = {
  loadV8(): V8Like | undefined {
    const load = (process as { getBuiltinModule?: (id: string) => unknown })
      .getBuiltinModule;
    if (typeof load !== "function") return undefined;
    return load.call(process, "node:v8") as V8Like | undefined;
  },
  now: (): number => Date.now(),
  elapsed: (): number => performance.now(),
  defer: (work: () => void): void => {
    setImmediate(work);
  },
};

/** What the process-wide slot holds. Versioned: another package copy may read it. */
interface SlotV1 {
  readonly version: 1;
  running: ProfileRunning | null;
  /** When the last capture ended (optional and additive: older copies ignore it). */
  lastEndedAtUnixMs?: number;
}

const SLOT_KEY = Symbol.for("nestrix.profiler");

/** The process-wide slot, created on first use. `undefined` when it is unusable. Never throws. */
function slot(): SlotV1 | undefined {
  try {
    const g = globalThis as Record<symbol, unknown>;
    let s = g[SLOT_KEY] as SlotV1 | undefined;
    if (s === undefined) {
      s = { version: 1, running: null };
      Object.defineProperty(g, SLOT_KEY, {
        value: s,
        configurable: true,
        enumerable: false,
        writable: false,
      });
    }
    return s !== null && typeof s === "object" && s.version === 1
      ? s
      : undefined;
  } catch {
    return undefined;
  }
}

/** The running capture in this process, from whichever copy started it. Never throws. */
export function runningCapture(): ProfileRunning | null {
  const running = slot()?.running;
  return running === undefined ? null : running;
}

/**
 * How a started capture ended, for the caller that passed `onEnd` to `start` (the remote poller,
 * P10-01). `done` carries the normalised `.cpuprofile` JSON, the same string `download` returns.
 */
export type CaptureEnd =
  | {
      readonly outcome: "done";
      readonly id: string;
      readonly json: string;
      readonly summary: ProfileSummary;
    }
  | {
      readonly outcome: "failed";
      readonly id: string;
      readonly message: string;
    }
  | { readonly outcome: "discarded"; readonly id: string };

export type CaptureEndListener = (end: CaptureEnd) => void;

interface Capture {
  readonly info: ProfileRunning;
  readonly handle: CpuProfileHandleLike;
  readonly owner: object;
  /** Cleared once called, so it runs at most once. */
  onEnd: CaptureEndListener | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface StoredProfile {
  readonly summary: ProfileSummary;
  readonly json: string;
  readonly topFunctions: ProfileFunction[];
  readonly flame: FlameNode;
}

export type StartResult =
  | { readonly outcome: "started"; readonly running: ProfileRunning }
  | { readonly outcome: "busy"; readonly running: ProfileRunning | null }
  | { readonly outcome: "cooldown"; readonly retryAfterSeconds: number }
  | { readonly outcome: "failed"; readonly message: string };

const FAILURE_LINE =
  "Nestrix profiler: a CPU capture failed; the dashboard shows the reason. The application is unaffected.";

function messageOf(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === "string") {
      return error.message.slice(0, 300);
    }
  } catch {
    // Fall through.
  }
  return "unknown error";
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

export class Profiler {
  private v8: V8Like | undefined;
  private capture: Capture | undefined;
  private readonly profiles: StoredProfile[] = [];
  private lastError: { atUnixMs: number; message: string } | null = null;
  private lastPauseMs: number | null = null;

  constructor(private readonly diagnostics: Diagnostics = defaultDiagnostics) {}

  /**
   * Starts a capture of `durationMs` (1 s to the maximum, whole seconds) owned by `owner` (the
   * dashboard or the remote poller that asked). `onEnd`, when given, is called once when a
   * started capture ends: normalised, failed, or discarded. It is not called when the start
   * itself is refused (the result says why). A throwing `onEnd` is counted. Never throws.
   */
  start(
    durationMs: number,
    owner: object,
    onEnd?: CaptureEndListener,
  ): StartResult {
    try {
      if (
        !Number.isInteger(durationMs) ||
        durationMs < 1000 ||
        durationMs > PROFILE_LIMITS.maxDurationSeconds * 1000
      ) {
        return this.fail(new Error("invalid capture duration"));
      }
      const s = slot();
      if (s === undefined) {
        return this.fail(
          new Error("the process-wide profiler slot is unusable"),
        );
      }
      if (s.running !== null) {
        const stale =
          typeof s.running.endsAtUnixMs !== "number" ||
          s.running.endsAtUnixMs + STALE_SLOT_GRACE_MS < profilerRuntime.now();
        if (!stale || this.capture !== undefined) {
          return { outcome: "busy", running: s.running };
        }
        s.running = null;
      }
      const ended = s.lastEndedAtUnixMs;
      if (typeof ended === "number") {
        const waitMs = ended + COOLDOWN_MS - profilerRuntime.now();
        if (waitMs > 0) {
          return {
            outcome: "cooldown",
            retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
          };
        }
      }
      if (this.v8 === undefined) this.v8 = profilerRuntime.loadV8();
      const v8 = this.v8;
      if (v8 === undefined || typeof v8.startCpuProfile !== "function") {
        return this.fail(
          new Error("v8.startCpuProfile is not available in this Node.js"),
        );
      }
      const startedAtUnixMs = profilerRuntime.now();
      const before = profilerRuntime.elapsed();
      const handle = v8.startCpuProfile({
        sampleInterval: SAMPLE_INTERVAL_MS,
        maxBufferSize: bufferSizeFor(durationMs),
      });
      const startPauseMs = round(profilerRuntime.elapsed() - before);
      const info: ProfileRunning = Object.freeze({
        id: randomBytes(8).toString("hex"),
        startedAtUnixMs,
        durationMs,
        endsAtUnixMs: startedAtUnixMs + durationMs,
        startPauseMs,
      });
      const capture: Capture = {
        info,
        handle,
        owner,
        onEnd,
        timer: undefined,
      };
      this.capture = capture;
      s.running = info;
      this.lastPauseMs = startPauseMs;
      try {
        capture.timer = setTimeout(() => this.finish(capture), durationMs);
        capture.timer.unref?.();
      } catch (error) {
        // Without an end timer the capture would run unbounded: discard it now. The start is
        // reported as failed, so `onEnd` is not called.
        this.release(capture);
        this.dispose(capture);
        return this.fail(error);
      }
      return { outcome: "started", running: info };
    } catch (error) {
      return this.fail(error);
    }
  }

  /** Discards the capture `owner` started, if one runs (app shutdown). Never throws. */
  discard(owner: object): void {
    try {
      const capture = this.capture;
      if (capture === undefined || capture.owner !== owner) return;
      this.release(capture);
      this.dispose(capture);
      this.notify(capture, { outcome: "discarded", id: capture.info.id });
    } catch (error) {
      this.diagnostics.countFailure("profiler.discard", error);
    }
  }

  /** Never throws. */
  list(): ProfileListResponse {
    return {
      running: runningCapture(),
      profiles: this.profiles.map((p) => p.summary),
      lastError: this.lastError,
      lastStartPauseMs: this.lastPauseMs,
      limits: { ...PROFILE_LIMITS },
    };
  }

  /** Never throws. */
  get(id: string): ProfileDetail | undefined {
    const p = this.profiles.find((x) => x.summary.id === id);
    if (p === undefined) return undefined;
    return { ...p.summary, topFunctions: p.topFunctions, flame: p.flame };
  }

  /** The normalised `.cpuprofile` and when it started, for the download. Never throws. */
  download(id: string): { json: string; startedAtUnixMs: number } | undefined {
    const p = this.profiles.find((x) => x.summary.id === id);
    return p === undefined
      ? undefined
      : { json: p.json, startedAtUnixMs: p.summary.startedAtUnixMs };
  }

  /** `MetaResponse.profiler`. Never throws. */
  meta(available: boolean): MetaProfiler {
    return { available, running: available && runningCapture() !== null };
  }

  private dispose(capture: Capture): void {
    try {
      capture.handle[Symbol.dispose]();
    } catch (error) {
      this.diagnostics.countFailure("profiler.discard", error);
    }
  }

  private release(capture: Capture): void {
    if (capture.timer !== undefined) clearTimeout(capture.timer);
    capture.timer = undefined;
    if (this.capture === capture) this.capture = undefined;
    const s = slot();
    if (s !== undefined && s.running?.id === capture.info.id) s.running = null;
  }

  /** The end timer. Stops, frees the slot, then normalises on a later turn. Never throws. */
  private finish(capture: Capture): void {
    try {
      if (this.capture !== capture) return;
      this.release(capture);
      const s = slot();
      if (s !== undefined) s.lastEndedAtUnixMs = profilerRuntime.now();
      let raw: string | undefined;
      try {
        raw = capture.handle.stop();
      } catch (error) {
        this.failCapture(capture, error);
        return;
      }
      if (typeof raw !== "string") {
        this.failCapture(
          capture,
          new Error("V8 returned no profile (the capture was already stopped)"),
        );
        return;
      }
      const json = raw;
      profilerRuntime.defer(() => this.keep(capture, json));
    } catch (error) {
      this.failCapture(capture, error);
    }
  }

  private keep(capture: Capture, raw: string): void {
    const info = capture.info;
    try {
      const n = normalizeProfile(raw);
      const summary: ProfileSummary = {
        id: info.id,
        startedAtUnixMs: info.startedAtUnixMs,
        durationMs: info.durationMs,
        actualDurationMs: round(n.actualDurationMs),
        startPauseMs: info.startPauseMs,
        samples: n.samples,
        bytes: Buffer.byteLength(n.json),
      };
      this.profiles.unshift({
        summary,
        json: n.json,
        topFunctions: n.topFunctions,
        flame: n.flame,
      });
      this.profiles.length = Math.min(
        this.profiles.length,
        PROFILE_LIMITS.kept,
      );
      this.notify(capture, {
        outcome: "done",
        id: info.id,
        json: n.json,
        summary,
      });
    } catch (error) {
      this.failCapture(capture, error);
    }
  }

  /** `fail`, then tells the capture's `onEnd`. Never throws. */
  private failCapture(capture: Capture, error: unknown): void {
    const result = this.fail(error);
    if (result.outcome === "failed") {
      this.notify(capture, {
        outcome: "failed",
        id: capture.info.id,
        message: result.message,
      });
    }
  }

  /** Calls the capture's `onEnd` at most once. Never throws. */
  private notify(capture: Capture, end: CaptureEnd): void {
    const listener = capture.onEnd;
    if (listener === undefined) return;
    capture.onEnd = undefined;
    try {
      listener(end);
    } catch (error) {
      this.diagnostics.countFailure("profiler.on-end", error);
    }
  }

  private fail(error: unknown): StartResult {
    const message = messageOf(error);
    try {
      this.lastError = { atUnixMs: profilerRuntime.now(), message };
      this.diagnostics.logOnce(
        "profiler.failure",
        `${FAILURE_LINE} (${message})`,
      );
    } catch {
      // Reporting must not throw either.
    }
    return { outcome: "failed", message };
  }
}

let shared: Profiler | undefined;

/** This package copy's profiler; the slot it claims is process-wide. */
export function getProfiler(): Profiler {
  shared ??= new Profiler();
  return shared;
}

/** Tests only: discard a running capture, empty the slot, and start from a fresh profiler. */
export function resetProfilerForTests(): void {
  const owner = (shared as unknown as { capture?: Capture } | undefined)
    ?.capture?.owner;
  if (owner !== undefined) shared?.discard(owner);
  const s = slot();
  if (s !== undefined) {
    s.running = null;
    delete s.lastEndedAtUnixMs;
  }
  shared = undefined;
}
