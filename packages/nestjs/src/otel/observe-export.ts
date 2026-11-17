/**
 * The exporter wrapper that feeds the export status (export-status.ts, D-82). It sits directly
 * around Nestrix's own OTLP exporter for each signal (traces, logs, metrics), reads every export's
 * result, classifies a failure, and passes the result on unchanged: what the batch processor or
 * metric reader sees is what it saw before. Duck-typed: no SDK class is extended or checked.
 *
 * One exception, issue #39: for metrics, an endpoint that answers 404, 405 or 501 does not accept
 * them. The wrapper then calls `onNotSupported` once and from then on answers every export with
 * `SUCCESS` without sending anything; the caller shuts the metric export down.
 *
 * Runs on the processors' and the reader's timers, never in a request path. The observation never
 * throws; a synchronous throw from the inner exporter is passed on as before.
 */
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import {
  type NestrixExportFailure,
  type NestrixExportFailureReason,
  type NestrixExportSignal,
  recordExportFailure,
  recordExportSuccess,
} from "../export-status.js";
import type { ResponseStatusTracker } from "./export-agent.js";

/** Network error codes that mean the endpoint could not be reached. */
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
]);

const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT"]);

function byStatus(status: number): NestrixExportFailureReason {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404 || status === 405 || status === 501) {
    return "not_supported";
  }
  if (status === 429) return "rate_limited";
  if (status === 408) return "timeout";
  if (status >= 500 && status <= 599) return "server_error";
  return "other";
}

function isHttpStatus(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  );
}

function codeOf(error: unknown): unknown {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code !== undefined) return code;
  // `AggregateError` from a dual-stack connect: the first attempt's code.
  const first = (error as { errors?: unknown[] } | null | undefined)
    ?.errors?.[0];
  return (first as { code?: unknown } | null | undefined)?.code;
}

/**
 * Why an export failed. `error` is the exporter's `ExportResult.error`: an `OTLPExporterError`
 * with the HTTP status as `code` for a status the exporter does not retry, a Node network error
 * with a string `code`, "Request timed out", or, for a retried status (429, 502, 503, 504), a
 * bare error without the status, which then comes from `observedStatus` (export-agent.ts).
 * Never throws.
 */
export function classifyExportError(
  error: unknown,
  observedStatus: number | undefined,
): NestrixExportFailure {
  try {
    const code = codeOf(error);
    if (isHttpStatus(code)) return { reason: byStatus(code), httpStatus: code };
    if (typeof code === "string") {
      if (TIMEOUT_CODES.has(code))
        return { reason: "timeout", httpStatus: null };
      if (UNREACHABLE_CODES.has(code)) {
        return { reason: "unreachable", httpStatus: null };
      }
    }
    const message = (error as { message?: unknown } | null | undefined)
      ?.message;
    if (typeof message === "string" && /\btime(?:d)? ?out\b/i.test(message)) {
      return { reason: "timeout", httpStatus: null };
    }
    if (isHttpStatus(observedStatus)) {
      return { reason: byStatus(observedStatus), httpStatus: observedStatus };
    }
  } catch {
    // Fall through.
  }
  return { reason: "other", httpStatus: null };
}

/** The exporter shape all three signals share. */
export interface ObservableExporter<T> {
  export(items: T, resultCallback: (result: ExportResult) => void): void;
  shutdown(): Promise<void>;
  forceFlush?(): Promise<void>;
}

export interface ObserveOptions {
  signal: NestrixExportSignal;
  /** The exporter's agents' status tracker, for the statuses the exporter does not report. */
  tracker?: ResponseStatusTracker | undefined;
  /**
   * Metrics only (#39): called once when the endpoint answers 404, 405 or 501. Afterwards every
   * export is answered `SUCCESS` without sending. When absent, `not_supported` is a failure like
   * any other.
   */
  onNotSupported?: ((failure: NestrixExportFailure) => void) | undefined;
}

/**
 * Wraps `inner`. Copies the optional methods a metric reader reads at construction
 * (`selectAggregationTemporality`, `selectAggregation`) when `inner` has them, bound to it.
 */
export function observeExports<T, E extends ObservableExporter<T>>(
  inner: E,
  options: ObserveOptions,
): ObservableExporter<T> {
  const { signal, tracker, onNotSupported } = options;
  let stopped = false;
  const observe = (result: ExportResult): void => {
    try {
      if (result.code === ExportResultCode.SUCCESS) {
        recordExportSuccess(signal);
        return;
      }
      const failure = classifyExportError(result.error, tracker?.lastStatus);
      if (failure.reason === "not_supported" && onNotSupported !== undefined) {
        if (stopped) return;
        stopped = true;
        onNotSupported(failure);
        return;
      }
      recordExportFailure(signal, failure);
    } catch {
      // Observing never changes the export.
    }
  };
  const wrapper: ObservableExporter<T> & Record<string, unknown> = {
    export(items, resultCallback) {
      if (stopped) {
        resultCallback({ code: ExportResultCode.SUCCESS });
        return;
      }
      try {
        if (tracker !== undefined) tracker.lastStatus = undefined;
      } catch {
        // Best effort.
      }
      inner.export(items, (result) => {
        observe(result);
        resultCallback(result);
      });
    },
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
  };
  for (const name of ["selectAggregationTemporality", "selectAggregation"]) {
    const method = (inner as unknown as Record<string, unknown>)[name];
    if (typeof method === "function") wrapper[name] = method.bind(inner);
  }
  return wrapper;
}
