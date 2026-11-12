/**
 * Remote CPU profiling: the check-in poller (P10-01, D-76; wire contract
 * `packages/protocol/src/remote-profiles.ts`).
 *
 * With `export.profiler: true`, the instance checks in with the standalone server over the export
 * endpoint, with the export headers (the ingest key). When the answer carries a capture order, the
 * capture runs through this package's on-demand profiler (`getProfiler()`: same limits, the
 * process-wide slot, the cool-down) and the instance uploads the normalised `.cpuprofile` itself,
 * gzipped. A refused start is reported to `…/profiles/<id>/failed`. The server never connects to
 * the instance.
 *
 * - First check-in a few seconds after `start()` (jittered), never inside bootstrap. Then every
 *   `nextCheckInMs` (default 15 s) clamped to 5 s to 5 min, ±20% jitter. Every timer is unref'ed.
 * - 404/405: not a Nestrix server (a Collector, Jaeger). One log line; polling stops for good.
 *   401/403: one log line; retried every 5 min. Network errors, timeouts, 429, 5xx and anything
 *   else: exponential backoff from 15 s to 5 min. Logged once per change of state, not per attempt.
 * - Its own requests are invisible to tracing: every request runs in a context carrying
 *   OpenTelemetry's suppress-tracing key, the same mechanism the SDK's span processors use around
 *   an export (`outbound/rules.ts`). Nestrix's fetch/undici subscriber, and any host
 *   instrumentation that honours the key, create no span and inject no `traceparent`. It never
 *   enters an incoming request, so it is not in route statistics either.
 * - Requests go through `unrefFetch` (`node:http`, `agent: false`, unref'ed sockets): a request in
 *   flight never keeps a short-lived host process alive.
 * - Redirects are not followed (`redirect: "manual"`), so the export headers are never sent to
 *   another URL; a 3xx counts as a failure.
 * - `stop()` clears the timer, aborts every in-flight request and discards a capture this poller
 *   started.
 * - Each check-in carries `runtimeSample` (P15-03, D-80): CPU, heap and RSS read at that moment,
 *   and the event-loop p99 when the embedded dashboard's sampler has one (`check-in-runtime.ts`).
 *   No timer or histogram of its own; a failure to read leaves the field out and the check-in goes
 *   ahead.
 *
 * Rule 1: every timer, callback and promise body catches everything; nothing throws into the
 * application and no promise is left to reject unhandled. Imports `@opentelemetry/api` only
 * (rule 5).
 */
import { createRequire } from "node:module";
import { gzip } from "node:zlib";
import type {
  CaptureFailedRequest,
  CheckInRequest,
  RuntimeSample,
} from "@nestrix-js/protocol";
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import type { Diagnostics } from "../diagnostics.js";
import type { InstanceIdentity } from "../otel/resource.js";
import { SUPPRESS_TRACING_KEY } from "../outbound/rules.js";
import type { ResolvedRemoteProfilerTarget } from "../resolve-options.js";
import {
  CheckInRuntime,
  type CheckInRuntimeReader,
} from "./check-in-runtime.js";
import {
  type CaptureEnd,
  type CaptureEndListener,
  getProfiler,
  PROFILE_LIMITS,
  type StartResult,
} from "./profiler.js";
import { unrefFetch } from "./unref-fetch.js";

export const CHECK_IN_PATH = "/v1/nestrix/check-in";
export const PROFILES_PATH = "/v1/nestrix/profiles";

/** Delays, milliseconds. Overridable for tests only. */
export interface PollerTiming {
  /** The first check-in happens between these two after `start()`. */
  readonly firstMinMs: number;
  readonly firstMaxMs: number;
  /** Used when the server's `nextCheckInMs` is missing or not a number. */
  readonly intervalMs: number;
  /** `nextCheckInMs` is clamped to this range. */
  readonly minIntervalMs: number;
  readonly maxIntervalMs: number;
  /** ± this share of each delay. */
  readonly jitter: number;
  /** After 401/403. */
  readonly authRetryMs: number;
  /** Exponential backoff after a failure: first delay, then doubled up to the maximum. */
  readonly backoffStartMs: number;
  readonly backoffMaxMs: number;
  /** Floor of the upload's timeout (the profile can be a few MB). */
  readonly uploadTimeoutMs: number;
}

export const DEFAULT_POLLER_TIMING: PollerTiming = Object.freeze({
  firstMinMs: 2_000,
  firstMaxMs: 5_000,
  intervalMs: 15_000,
  minIntervalMs: 5_000,
  maxIntervalMs: 300_000,
  jitter: 0.2,
  authRetryMs: 300_000,
  backoffStartMs: 15_000,
  backoffMaxMs: 300_000,
  uploadTimeoutMs: 60_000,
});

/**
 * Seams for tests (module-level, like `profilerRuntime`), for pollers the core builds. Internal;
 * not exported from the package entry.
 */
export const remoteRuntime: { timing: Partial<PollerTiming> } = {
  timing: {},
};

/** The largest check-in answer read; a bigger one counts as a failure. */
export const MAX_CHECK_IN_RESPONSE_BYTES = 64 * 1024;

/** `CaptureFailedRequest.message` is cut to this length (the server cuts to 500 too). */
const MAX_FAILED_MESSAGE = 500;

const CAPTURE_ID = /^[0-9a-f]{16}$/;

/** The part of the profiler the poller uses. */
export interface PollerProfiler {
  start(
    durationMs: number,
    owner: object,
    onEnd?: CaptureEndListener,
  ): StartResult;
  discard(owner: object): void;
}

export interface RemotePollerConfig {
  readonly target: ResolvedRemoteProfilerTarget;
  readonly identity: InstanceIdentity;
  readonly diagnostics: Diagnostics;
  /** State-change lines (Nest's `Logger`, context `Nestrix`). May throw; the poller guards it. */
  readonly log: (message: string) => void;
  /**
   * The embedded dashboard's latest runtime sample while its sampler runs (for the check-in's
   * event-loop p99); omitted without a dashboard. May throw; the reader guards it.
   */
  readonly latestRuntimeSample?: () => RuntimeSample | null;
  /** Test seams. */
  readonly runtime?: CheckInRuntimeReader;
  readonly profiler?: PollerProfiler;
  readonly timing?: Partial<PollerTiming>;
  /** The transport; defaults to `unrefFetch` (`node:http` with unref'ed sockets). */
  readonly fetch?: typeof fetch;
  readonly random?: () => number;
}

/** `ok`: answered 200 last time. `auth`: 401/403. `failing`: backing off. `off`: stopped for good. */
type Health = "ok" | "auth" | "failing" | "off";

interface ActiveCapture {
  /** The server's id for the order. */
  readonly orderId: string;
  /** The profiler's own id, as `CaptureEnd.id` carries it. */
  readonly profilerId: string;
}

/** Runs `fn` with OpenTelemetry's suppress-tracing key set, from the root context. */
const SUPPRESSED = ROOT_CONTEXT.setValue(SUPPRESS_TRACING_KEY, true);
function untraced<T>(fn: () => T): T {
  return context.with(SUPPRESSED, fn);
}

let sdkVersion: string | null | undefined;

/** Version of this package, read once from its `package.json`; `undefined` when unreadable. */
function readSdkVersion(): string | undefined {
  if (sdkVersion === undefined) {
    try {
      // src/profiler/remote.ts and dist/profiler/remote.js are both two levels below it.
      const pkg = createRequire(import.meta.url)("../../package.json") as {
        version?: unknown;
      };
      sdkVersion = typeof pkg.version === "string" ? pkg.version : null;
    } catch {
      sdkVersion = null;
    }
  }
  return sdkVersion ?? undefined;
}

function describe(error: unknown): string {
  try {
    if (error instanceof Error) {
      const cause = (error as { cause?: unknown }).cause;
      const code =
        cause !== null && typeof cause === "object"
          ? (cause as { code?: unknown }).code
          : undefined;
      const name = error.name === "TimeoutError" ? "timed out" : error.message;
      return typeof code === "string" ? `${name}: ${code}` : name;
    }
  } catch {
    // Fall through.
  }
  return "unknown error";
}

function gzipAsync(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(input, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

/** Cancels an unread body so the socket is freed. Never throws. */
function discardBody(response: Response): void {
  try {
    response.body?.cancel().catch(() => undefined);
  } catch {
    // Nothing to free.
  }
}

/** The body as text, or a throw when it is larger than `max` bytes. */
async function readCapped(response: Response, max: number): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      reader.cancel().catch(() => undefined);
      throw new Error(`the answer is larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The check-in URL without userinfo or query, for log lines. */
function shownUrl(baseUrl: string): string {
  try {
    const u = new URL(`${baseUrl}${CHECK_IN_PATH}`);
    return `${u.origin}${u.pathname}`;
  } catch {
    return CHECK_IN_PATH;
  }
}

const PREFIX = "Nestrix remote profiler:";

export class RemoteProfilerPoller {
  private readonly timing: PollerTiming;
  private readonly profiler: PollerProfiler;
  private readonly fetchFn: typeof fetch;
  private readonly random: () => number;
  private readonly lifetime = new AbortController();
  private readonly url: string;
  private readonly runtime: CheckInRuntimeReader;
  private started = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private health: Health = "ok";
  private backoffMs = 0;
  private capture: ActiveCapture | undefined;
  /** Resolves when the check-in in flight has been handled (tests). */
  private current: Promise<void> | undefined;

  constructor(private readonly config: RemotePollerConfig) {
    this.timing = {
      ...DEFAULT_POLLER_TIMING,
      ...remoteRuntime.timing,
      ...config.timing,
    };
    this.profiler = config.profiler ?? getProfiler();
    this.fetchFn = config.fetch ?? (unrefFetch as typeof fetch);
    this.random = config.random ?? Math.random;
    this.url = shownUrl(config.target.baseUrl);
    this.runtime =
      config.runtime ??
      new CheckInRuntime(config.diagnostics, config.latestRuntimeSample);
  }

  /** Schedules the first check-in a few seconds from now. Idempotent. Never throws. */
  start(): void {
    try {
      if (this.started || this.stopped) return;
      this.started = true;
      try {
        this.runtime.start();
      } catch (error) {
        this.config.diagnostics.countFailure("profiler.remote.runtime", error);
      }
      const { firstMinMs, firstMaxMs } = this.timing;
      this.schedule(
        firstMinMs + this.random() * Math.max(0, firstMaxMs - firstMinMs),
      );
    } catch (error) {
      this.config.diagnostics.countFailure("profiler.remote", error);
    }
  }

  /**
   * Stops for good: clears the timer, aborts in-flight requests and discards a capture this
   * poller started. Idempotent. Never throws.
   */
  stop(): void {
    this.stopped = true;
    try {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
    } catch (error) {
      this.config.diagnostics.countFailure("profiler.remote", error);
    }
    try {
      this.lifetime.abort();
    } catch (error) {
      this.config.diagnostics.countFailure("profiler.remote", error);
    }
    try {
      this.profiler.discard(this);
    } catch (error) {
      this.config.diagnostics.countFailure("profiler.remote", error);
    }
    this.capture = undefined;
  }

  /** Tests: whether a timer is scheduled. */
  get scheduled(): boolean {
    return this.timer !== undefined;
  }

  /** Tests: the check-in in flight, if any. Never rejects. */
  idle(): Promise<void> {
    return this.current ?? Promise.resolve();
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    const timer = setTimeout(
      () => {
        try {
          this.timer = undefined;
          this.current = untraced(() => this.tick());
        } catch (error) {
          this.config.diagnostics.countFailure("profiler.remote", error);
        }
      },
      Math.max(0, Math.round(ms)),
    );
    timer.unref?.();
    this.timer = timer;
  }

  /** One check-in and the next schedule. Never rejects. */
  private async tick(): Promise<void> {
    let next: number | undefined;
    try {
      next = await this.checkIn();
    } catch (error) {
      this.config.diagnostics.countFailure("profiler.remote", error);
      try {
        next = this.failing("an internal error");
      } catch {
        next = this.timing.backoffMaxMs;
      }
    }
    try {
      if (next !== undefined && !this.stopped) this.schedule(next);
    } catch (error) {
      this.config.diagnostics.countFailure("profiler.remote", error);
    }
  }

  /** The delay before the next check-in, or `undefined` to stop polling. */
  private async checkIn(): Promise<number | undefined> {
    if (this.stopped) return undefined;
    const { identity } = this.config;
    const body: CheckInRequest = {
      service: identity.service,
      instanceId: identity.instanceId,
      pid: process.pid,
      runtime: process.version,
    };
    if (identity.version !== undefined) body.version = identity.version;
    if (identity.host !== undefined) body.host = identity.host;
    const version = readSdkVersion();
    if (version !== undefined) body.sdkVersion = version;
    if (this.capture !== undefined) {
      body.runningCaptureId = this.capture.orderId;
    }
    try {
      const sample = this.runtime.read();
      if (sample !== undefined) body.runtimeSample = sample;
    } catch (error) {
      this.config.diagnostics.countFailure("profiler.remote.runtime", error);
    }

    let response: Response;
    try {
      response = await this.post(
        CHECK_IN_PATH,
        JSON.stringify(body),
        { "content-type": "application/json" },
        this.config.target.timeoutMillis,
      );
    } catch (error) {
      if (this.stopped) return undefined;
      return this.failing(describe(error));
    }
    if (this.stopped) {
      discardBody(response);
      return undefined;
    }
    const status = response.status;
    if (status === 200) {
      let answer: unknown;
      try {
        answer = JSON.parse(
          await readCapped(response, MAX_CHECK_IN_RESPONSE_BYTES),
        );
      } catch (error) {
        if (this.stopped) return undefined;
        return this.failing(`unreadable answer (${describe(error)})`);
      }
      if (answer === null || typeof answer !== "object") {
        return this.failing("unreadable answer (not a JSON object)");
      }
      this.healthy();
      const { capture, nextCheckInMs } = answer as {
        capture?: unknown;
        nextCheckInMs?: unknown;
      };
      this.handleOrder(capture);
      return this.jittered(this.clampInterval(nextCheckInMs));
    }
    discardBody(response);
    if (status === 404 || status === 405) {
      this.health = "off";
      this.say(
        `${this.url} answered ${status}, so the export endpoint is not a Nestrix server (it may be an OpenTelemetry Collector or Jaeger). Remote profiling is off until the app restarts; set export.profiler: false to silence this.`,
      );
      return undefined;
    }
    if (status === 401 || status === 403) {
      if (this.health !== "auth") {
        this.say(
          `${this.url} answered ${status}: the ingest key in export.otlp.headers was refused. Retrying every ${Math.round(this.timing.authRetryMs / 1000)} s.`,
        );
      }
      this.health = "auth";
      this.backoffMs = 0;
      return this.jittered(this.timing.authRetryMs);
    }
    return this.failing(`HTTP ${status}`);
  }

  /** Enters or stays in the failing state; returns the next backoff delay. */
  private failing(reason: string): number {
    if (this.health !== "failing") {
      this.say(
        `check-in at ${this.url} failed (${reason}). Retrying with backoff up to ${Math.round(this.timing.backoffMaxMs / 1000)} s; the application is unaffected.`,
      );
    }
    this.health = "failing";
    this.backoffMs =
      this.backoffMs === 0
        ? this.timing.backoffStartMs
        : Math.min(this.backoffMs * 2, this.timing.backoffMaxMs);
    return this.jittered(this.backoffMs);
  }

  private healthy(): void {
    if (this.health === "failing" || this.health === "auth") {
      this.say(`check-in at ${this.url} works again.`);
    }
    this.health = "ok";
    this.backoffMs = 0;
  }

  private clampInterval(value: unknown): number {
    const ms =
      typeof value === "number" && Number.isFinite(value)
        ? value
        : this.timing.intervalMs;
    return Math.min(
      this.timing.maxIntervalMs,
      Math.max(this.timing.minIntervalMs, ms),
    );
  }

  private jittered(ms: number): number {
    const share = (this.random() * 2 - 1) * this.timing.jitter;
    return Math.max(0, ms * (1 + share));
  }

  /** Starts the ordered capture, or reports why it cannot. Never throws. */
  private handleOrder(order: unknown): void {
    try {
      if (order === undefined || order === null) return;
      if (typeof order !== "object") return;
      const { id, durationMs } = order as {
        id?: unknown;
        durationMs?: unknown;
      };
      if (typeof id !== "string" || !CAPTURE_ID.test(id)) {
        this.config.diagnostics.logOnce(
          "profiler.remote-bad-order",
          `${PREFIX} the server sent a capture order with an invalid id; it was ignored.`,
        );
        return;
      }
      // The server hands an order over once; if it repeats one this poller runs, keep running.
      if (this.capture?.orderId === id) return;
      if (this.capture !== undefined) {
        this.reportFailed(id, "busy");
        return;
      }
      if (
        typeof durationMs !== "number" ||
        !Number.isInteger(durationMs) ||
        durationMs < 1000 ||
        durationMs > PROFILE_LIMITS.maxDurationSeconds * 1000
      ) {
        this.reportFailed(id, "invalid capture duration");
        return;
      }
      const result = this.profiler.start(durationMs, this, (end) =>
        this.onCaptureEnd(end),
      );
      switch (result.outcome) {
        case "started":
          this.capture = { orderId: id, profilerId: result.running.id };
          return;
        case "busy":
          this.reportFailed(id, "busy");
          return;
        case "cooldown":
          this.reportFailed(id, "cooldown");
          return;
        default:
          this.reportFailed(id, result.message);
      }
    } catch (error) {
      this.config.diagnostics.countFailure("profiler.remote", error);
    }
  }

  /** The profiler's `onEnd`. Never throws. */
  private onCaptureEnd(end: CaptureEnd): void {
    try {
      const capture = this.capture;
      if (capture === undefined || capture.profilerId !== end.id) return;
      if (this.stopped || end.outcome === "discarded") {
        this.capture = undefined;
        return;
      }
      if (end.outcome === "failed") {
        this.capture = undefined;
        this.reportFailed(capture.orderId, end.message);
        return;
      }
      void untraced(() => this.upload(capture, end.json));
    } catch (error) {
      this.config.diagnostics.countFailure("profiler.remote", error);
    }
  }

  /** Gzips and uploads the profile, then frees the capture. Never rejects. */
  private async upload(capture: ActiveCapture, json: string): Promise<void> {
    try {
      const gzipped = await gzipAsync(Buffer.from(json, "utf8"));
      if (this.stopped) return;
      const response = await this.post(
        `${PROFILES_PATH}/${capture.orderId}`,
        // fetch's `BodyInit` takes a view on a plain `ArrayBuffer`, not `Buffer<ArrayBufferLike>`.
        new Uint8Array(gzipped),
        { "content-type": "application/json", "content-encoding": "gzip" },
        Math.max(this.config.target.timeoutMillis, this.timing.uploadTimeoutMs),
      );
      discardBody(response);
      if (!response.ok && !this.stopped) {
        this.say(
          `the upload of capture ${capture.orderId} was refused (HTTP ${response.status}).`,
        );
        // 404/409: the server no longer expects this capture; anything else: tell it why.
        if (response.status !== 404 && response.status !== 409) {
          await this.sendFailed(
            capture.orderId,
            `upload refused: HTTP ${response.status}`,
          );
        }
      }
    } catch (error) {
      if (!this.stopped) {
        this.say(
          `the upload of capture ${capture.orderId} failed (${describe(error)}).`,
        );
      }
    } finally {
      if (this.capture === capture) this.capture = undefined;
    }
  }

  /** Fire-and-forget `sendFailed`. Never throws. */
  private reportFailed(id: string, message: string): void {
    try {
      void untraced(() => this.sendFailed(id, message));
    } catch (error) {
      this.config.diagnostics.countFailure("profiler.remote", error);
    }
  }

  /** `POST …/profiles/<id>/failed`. Never rejects. */
  private async sendFailed(id: string, message: string): Promise<void> {
    try {
      if (this.stopped) return;
      const body: CaptureFailedRequest = {
        message: message.slice(0, MAX_FAILED_MESSAGE),
      };
      const response = await this.post(
        `${PROFILES_PATH}/${id}/failed`,
        JSON.stringify(body),
        { "content-type": "application/json" },
        this.config.target.timeoutMillis,
      );
      discardBody(response);
    } catch {
      // The server expires a capture nobody reports on.
    }
  }

  /** One POST under this poller's lifetime and a timeout. Rejects on network errors. */
  private post(
    path: string,
    body: string | Uint8Array<ArrayBuffer>,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<Response> {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(timeoutMs),
    ]);
    return this.fetchFn(`${this.config.target.baseUrl}${path}`, {
      method: "POST",
      headers: { ...this.config.target.headers, ...headers },
      body,
      signal,
      redirect: "manual",
    });
  }

  private say(message: string): void {
    try {
      this.config.log(`${PREFIX} ${message}`);
    } catch {
      // Logging must not throw either.
    }
  }
}
