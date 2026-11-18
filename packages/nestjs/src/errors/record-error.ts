/**
 * `recordError(error, attributes?, options?)`: report an error the application handled (issue #24,
 * D-93). For a host's `@Catch()` filter (guards and middleware throw before Nestrix's interceptor,
 * and D-14 rules out a Nestrix exception filter), a job that catches and retries, a background task
 * that degrades.
 *
 * Imports `@opentelemetry/api` only (rule 5). Never throws (rule 1).
 */
import {
  type Attributes,
  context,
  isSpanContextValid,
  type Span,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { ATTR_ERROR_TYPE } from "@opentelemetry/semantic-conventions";
import { diagnostics } from "../diagnostics.js";
import { getStateFromContext, maybeFault } from "../http/request-state.js";
import { endNestrixSpan, startNestrixSpan } from "../trace-limit.js";
import {
  errorTrackingEnabled,
  exceptionType,
  isExpectedException,
  localRootOf,
  recordExceptionEvent,
} from "./exception.js";

const TRACER_NAME = "@nestrix-js/nestjs";
/** Name of the short span `recordError` starts when no span is active. */
export const RECORD_ERROR_SPAN_NAME = "recordError";

/** Options of {@link recordError}. */
export interface RecordErrorOptions {
  /**
   * Set error status on the span the error is recorded on, so it counts as an error (error lists,
   * error groups, the trace's error marker; on a request's span, the route's error rate too).
   * Default: `true`, unless the exception is expected (an `HttpException` below 500, or what
   * `errors.expected` says).
   */
  readonly fail?: boolean;
}

function isRecordingSpan(span: Span | undefined): span is Span {
  try {
    return span?.isRecording() === true;
  } catch {
    return false;
  }
}

/**
 * Records a handled error on the local root span of the current trace: the HTTP request's server
 * span, the job's or scheduled tick's root, the RPC handler's span. When that span has ended or
 * there is none, on the active span; outside any span, on a short span of its own named
 * `recordError`. The event carries `exception.escaped = false` and `attributes` (strings, numbers,
 * booleans and arrays of them; `exception.*` and `nestrix.exception.*` keys are ignored).
 *
 * An error object is counted once per trace: when Nestrix already recorded the same object (a
 * method span or the HTTP interceptor saw it thrown), this records only a propagation mark and
 * does not add an occurrence. With Nestrix disabled, or before any Nestrix app has started, it does
 * nothing. Never throws.
 */
export function recordError(
  error: unknown,
  attributes?: Attributes,
  options?: RecordErrorOptions,
): void {
  try {
    if (!errorTrackingEnabled()) return;
    maybeFault("record-error");
    const ctx = context.active();
    const active = trace.getSpan(ctx);
    const activeContext = active?.spanContext();
    let failOption: unknown;
    try {
      failOption = options?.fail;
    } catch {
      failOption = undefined;
    }
    const fail =
      typeof failOption === "boolean"
        ? failOption
        : !isExpectedException(error);

    const state = getStateFromContext(ctx);
    // First that is still recording and in the active span's trace: the request's span, then the
    // nearest local root Nestrix started (a scheduled tick inside a request starts a trace of its
    // own and is marked as a root, so the request's span is skipped there), then the active span.
    const candidates = [
      state !== undefined && !state.ended ? state.span : undefined,
      localRootOf(ctx),
      active,
    ];
    let target: Span | undefined;
    for (const candidate of candidates) {
      if (!isRecordingSpan(candidate)) continue;
      if (
        activeContext !== undefined &&
        candidate.spanContext().traceId !== activeContext.traceId
      ) {
        continue;
      }
      target = candidate;
      break;
    }

    if (target !== undefined) {
      recordExceptionEvent(target, error, {
        escaped: false,
        attributes,
        // The request's span or a local root: an error recorded below it travelled up to it.
        root: target === candidates[0] || target === candidates[1],
        followCause: true,
      });
      if (fail) {
        target.setStatus({ code: SpanStatusCode.ERROR });
        if (state !== undefined && target === state.span) {
          // The request failed: route statistics and `error.type` at close see it (server.ts).
          state.exception ??= { status: 500, type: exceptionType(error) };
        } else {
          target.setAttribute(ATTR_ERROR_TYPE, exceptionType(error));
        }
      }
      return;
    }
    // An unsampled trace records nothing, as every other span of it.
    if (
      activeContext !== undefined &&
      (activeContext.traceFlags & TraceFlags.SAMPLED) === 0 &&
      isSpanContextValid(activeContext)
    ) {
      return;
    }
    const span = startNestrixSpan(
      trace.getTracer(TRACER_NAME),
      RECORD_ERROR_SPAN_NAME,
      { kind: SpanKind.INTERNAL },
      ctx,
    );
    try {
      recordExceptionEvent(span, error, {
        escaped: false,
        attributes,
        followCause: true,
      });
      if (fail) {
        span.setAttribute(ATTR_ERROR_TYPE, exceptionType(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
    } finally {
      endNestrixSpan(span);
    }
  } catch (failure) {
    diagnostics.countFailure("errors.record-error", failure);
  }
}
