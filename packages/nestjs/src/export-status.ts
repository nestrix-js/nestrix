/**
 * Export status (issues #21 and #39, D-82): what Nestrix's own OTLP pipeline knows about its
 * exports, per signal, for the host to read (`getExportStatus()`), to log at most once per change
 * of state, and to report as two observable counters (metrics/binding.ts).
 *
 * Read-only and process-wide, like the owned pipeline itself. Only Nestrix's own exporters feed it:
 * with a host-owned SDK (D-69), or with Nestrix disabled, every signal stays `inactive`.
 *
 * Fed from the exporters' result callbacks (otel/observe-export.ts), which run on the batch
 * processors' and the metric reader's timers, never in a request path. Nothing here throws.
 */
import { Logger } from "@nestjs/common";

/** The OTLP signals Nestrix can export. */
export type NestrixExportSignal = "traces" | "logs" | "metrics";

/**
 * Why an export failed:
 * - `unreachable`: no connection (refused, reset, DNS, no route).
 * - `unauthorized`: HTTP 401 or 403 (a missing, wrong or revoked ingest key).
 * - `rate_limited`: HTTP 429.
 * - `server_error`: HTTP 5xx other than 501.
 * - `timeout`: no answer within `export.otlp.timeoutMillis` (or HTTP 408).
 * - `not_supported`: HTTP 404, 405 or 501: the endpoint does not accept this signal.
 * - `other`: anything else (another 4xx, a malformed response).
 */
export type NestrixExportFailureReason =
  | "unreachable"
  | "unauthorized"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "not_supported"
  | "other";

/**
 * - `inactive`: Nestrix does not export this signal (export off, the host's SDK owns it, Nestrix
 *   disabled, or the app closed).
 * - `pending`: exporting, no export has finished yet.
 * - `ok`: the last export succeeded.
 * - `failing`: the last export failed.
 * - `stopped`: the endpoint does not accept this signal (`not_supported`), so Nestrix stopped
 *   exporting it until the process restarts. Only metrics stop.
 */
export type NestrixExportState =
  | "inactive"
  | "pending"
  | "ok"
  | "failing"
  | "stopped";

const SIGNALS: readonly NestrixExportSignal[] = ["traces", "logs", "metrics"];

export interface NestrixExportFailure {
  readonly reason: NestrixExportFailureReason;
  /** The HTTP status of the last answer, when there was one. */
  readonly httpStatus: number | null;
}

export interface NestrixSignalExportStatus {
  readonly state: NestrixExportState;
  /** When the last export succeeded, in milliseconds since the epoch. */
  readonly lastSuccessAt: number | null;
  /** When the last export failed, in milliseconds since the epoch. */
  readonly lastFailureAt: number | null;
  readonly lastFailure: NestrixExportFailure | null;
  /** Failed exports since the last success. */
  readonly consecutiveFailures: number;
  /** Failed exports since this signal's export started, by reason. */
  readonly failures: Readonly<Record<NestrixExportFailureReason, number>>;
  /**
   * Spans (traces) or log records (logs) dropped before export because the bounded queue was full.
   * Always 0 for metrics, which are aggregated, not queued.
   */
  readonly dropped: number;
}

export interface NestrixExportStatus {
  /** `true` when a signal Nestrix exports is `failing` or `stopped`. Telemetry only: never a reason to restart. */
  readonly degraded: boolean;
  readonly traces: NestrixSignalExportStatus;
  readonly logs: NestrixSignalExportStatus;
  readonly metrics: NestrixSignalExportStatus;
}

interface SignalState {
  state: NestrixExportState;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailure: NestrixExportFailure | null;
  consecutiveFailures: number;
  failures: Record<NestrixExportFailureReason, number>;
  dropped: number;
  /** Reasons already logged in the current failing episode (one line per reason at most). */
  logged: Set<NestrixExportFailureReason>;
  /** `dropped` when the current failing episode began. */
  droppedAtEpisodeStart: number;
}

function zeroFailures(): Record<NestrixExportFailureReason, number> {
  return {
    unreachable: 0,
    unauthorized: 0,
    rate_limited: 0,
    server_error: 0,
    timeout: 0,
    not_supported: 0,
    other: 0,
  };
}

function freshState(state: NestrixExportState): SignalState {
  return {
    state,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailure: null,
    consecutiveFailures: 0,
    failures: zeroFailures(),
    dropped: 0,
    logged: new Set(),
    droppedAtEpisodeStart: 0,
  };
}

const states: Record<NestrixExportSignal, SignalState> = {
  traces: freshState("inactive"),
  logs: freshState("inactive"),
  metrics: freshState("inactive"),
};

const LOG_CONTEXT = "Nestrix";
let logger: Logger | undefined;

/** Internal test seam: where the state-change lines go. */
export const exportStatusLog: {
  warn(message: string): void;
  log(message: string): void;
} = {
  warn(message) {
    logger ??= new Logger(LOG_CONTEXT);
    logger.warn(message);
  },
  log(message) {
    logger ??= new Logger(LOG_CONTEXT);
    logger.log(message);
  },
};

function safeLog(level: "warn" | "log", message: string): void {
  try {
    exportStatusLog[level](message);
  } catch {
    // A logger that throws changes nothing here.
  }
}

const NOUN: Record<NestrixExportSignal, string> = {
  traces: "spans",
  logs: "log records",
  metrics: "metrics",
};

const DESCRIBE: Record<NestrixExportFailureReason, string> = {
  unreachable: "the endpoint is unreachable",
  unauthorized: "the endpoint refused the credentials",
  rate_limited: "the endpoint is rate limiting",
  server_error: "the endpoint answered with a server error",
  timeout: "the export timed out",
  not_supported: "the endpoint does not accept this signal",
  other: "the export failed",
};

function describe(failure: NestrixExportFailure): string {
  const status =
    failure.httpStatus === null ? "" : `, HTTP ${failure.httpStatus}`;
  return `${failure.reason}${status}: ${DESCRIBE[failure.reason]}`;
}

const INACTIVE_SIGNAL: NestrixSignalExportStatus = Object.freeze({
  state: "inactive",
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailure: null,
  consecutiveFailures: 0,
  failures: Object.freeze(zeroFailures()),
  dropped: 0,
});

const INACTIVE_STATUS: NestrixExportStatus = Object.freeze({
  degraded: false,
  traces: INACTIVE_SIGNAL,
  logs: INACTIVE_SIGNAL,
  metrics: INACTIVE_SIGNAL,
});

/**
 * Where Nestrix's own OTLP export stands, per signal: a snapshot of plain frozen objects. Every
 * signal is `inactive` when Nestrix is disabled, exports nothing, or the host's OpenTelemetry SDK
 * owns the signal (Nestrix never reads a host's exporters). Cheap (no I/O, a few small objects);
 * never throws.
 */
export function getExportStatus(): NestrixExportStatus {
  const read = (signal: NestrixExportSignal): NestrixSignalExportStatus => {
    const s = states[signal];
    return Object.freeze({
      state: s.state,
      lastSuccessAt: s.lastSuccessAt,
      lastFailureAt: s.lastFailureAt,
      lastFailure:
        s.lastFailure === null ? null : Object.freeze({ ...s.lastFailure }),
      consecutiveFailures: s.consecutiveFailures,
      failures: Object.freeze({ ...s.failures }),
      dropped: s.dropped,
    });
  };
  try {
    const traces = read("traces");
    const logs = read("logs");
    const metrics = read("metrics");
    const degraded = [traces, logs, metrics].some(
      (s) => s.state === "failing" || s.state === "stopped",
    );
    return Object.freeze({ degraded, traces, logs, metrics });
  } catch {
    // Unreachable in practice (plain objects); a caller's readiness check must never throw.
    return INACTIVE_STATUS;
  }
}

/** Whether Nestrix exports `signal` now (any state but `inactive`). */
export function isExportActive(signal: NestrixExportSignal): boolean {
  return states[signal].state !== "inactive";
}

/** The cumulative counts the observable counters report, for the signals that ever exported. */
export function exportCounts(): {
  signal: NestrixExportSignal;
  failures: Readonly<Record<NestrixExportFailureReason, number>>;
  dropped: number;
  active: boolean;
}[] {
  return SIGNALS.map((signal) => ({
    signal,
    failures: states[signal].failures,
    dropped: states[signal].dropped,
    active: states[signal].state !== "inactive",
  }));
}

/**
 * Nestrix's own exporter for `signal` starts: a fresh status (`pending`). Counts start again at
 * zero, because this is a new pipeline. Never throws.
 */
export function activateExport(signal: NestrixExportSignal): void {
  try {
    states[signal] = freshState("pending");
  } catch {
    // Never throws.
  }
}

/** Nestrix's own exporter for `signal` is gone (shut down). Counts are kept for reading. */
export function deactivateExport(signal: NestrixExportSignal): void {
  try {
    states[signal].state = "inactive";
    states[signal].logged.clear();
  } catch {
    // Never throws.
  }
}

/** An export of `signal` succeeded. Logs one line when it recovers from failing. */
export function recordExportSuccess(signal: NestrixExportSignal): void {
  try {
    const s = states[signal];
    if (s.state === "inactive" || s.state === "stopped") return;
    const wasFailing = s.state === "failing";
    const failed = s.consecutiveFailures;
    s.state = "ok";
    s.lastSuccessAt = Date.now();
    s.consecutiveFailures = 0;
    if (wasFailing) {
      s.logged.clear();
      const dropped = s.dropped - s.droppedAtEpisodeStart;
      const droppedNote =
        signal === "metrics"
          ? ""
          : `; ${dropped} ${NOUN[signal]} were dropped from the queue meanwhile`;
      safeLog(
        "log",
        `Exporting ${NOUN[signal]} to the OTLP endpoint works again, after ${failed} failed export${failed === 1 ? "" : "s"}${droppedNote}.`,
      );
    }
  } catch {
    // Never throws.
  }
}

/**
 * An export of `signal` failed. Logs one warning when the signal starts failing, and one more for
 * each other reason seen in the same failing episode; never one per batch. Never throws.
 */
export function recordExportFailure(
  signal: NestrixExportSignal,
  failure: NestrixExportFailure,
): void {
  try {
    const s = states[signal];
    if (s.state === "inactive" || s.state === "stopped") return;
    const wasFailing = s.state === "failing";
    s.state = "failing";
    s.lastFailureAt = Date.now();
    s.lastFailure = failure;
    s.consecutiveFailures++;
    s.failures[failure.reason]++;
    if (!wasFailing) {
      s.droppedAtEpisodeStart = s.dropped;
      s.logged.clear();
    }
    if (s.logged.has(failure.reason)) return;
    s.logged.add(failure.reason);
    const queued =
      signal === "metrics"
        ? "Metrics are kept aggregated and sent with the next successful export."
        : `New ${NOUN[signal]} are held in the bounded queue and dropped when it is full.`;
    safeLog(
      "warn",
      wasFailing
        ? `Exports of ${NOUN[signal]} to the OTLP endpoint now fail for another reason (${describe(failure)}).`
        : `Exports of ${NOUN[signal]} to the OTLP endpoint are failing (${describe(failure)}). ${queued} Requests are not affected. Further failures are counted in getExportStatus(), not logged; one line follows when exports succeed again.`,
    );
  } catch {
    // Never throws.
  }
}

/** `count` items of `signal` were dropped before export (queue full). Never throws. */
export function recordExportDropped(
  signal: NestrixExportSignal,
  count: number,
): void {
  try {
    if (!Number.isFinite(count) || count <= 0) return;
    const s = states[signal];
    if (s.state === "inactive") return;
    s.dropped += count;
  } catch {
    // Never throws.
  }
}

/**
 * The endpoint does not accept `signal` (`not_supported`): the failure is counted, the state becomes
 * `stopped` and one warning says so. The caller stops the exporter. Never throws.
 */
export function recordExportStopped(
  signal: NestrixExportSignal,
  failure: NestrixExportFailure,
  message: string,
): void {
  try {
    const s = states[signal];
    if (s.state === "inactive" || s.state === "stopped") return;
    s.state = "stopped";
    s.lastFailureAt = Date.now();
    s.lastFailure = failure;
    s.consecutiveFailures++;
    s.failures[failure.reason]++;
    safeLog("warn", message);
  } catch {
    // Never throws.
  }
}

/** Internal, for tests only. */
export function resetExportStatusForTests(): void {
  for (const signal of SIGNALS) states[signal] = freshState("inactive");
  logger = undefined;
}
