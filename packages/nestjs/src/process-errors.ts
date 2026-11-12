/**
 * Process-level errors, best effort (architecture §4.2, backlog P1-07).
 *
 * Only `uncaughtExceptionMonitor` is used. It observes an uncaught exception, and an unhandled
 * rejection that Node turns into one (`--unhandled-rejections=throw`, the default; `origin` is
 * then `"unhandledRejection"`), without changing what happens next. An `unhandledRejection` or
 * `uncaughtException` listener would change behaviour: adding either stops the default crash.
 *
 * What is recorded: when the error surfaces inside a request Nestrix traces, an exception event
 * on that server span (its status is still decided at `close`); otherwise a short span named
 * after `origin` carrying the exception. The process usually exits right after the monitor
 * returns, before the batch processor can export, so these spans reach the exporter only when
 * the process survives (the host handles the error itself). Never throws.
 */
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { ATTR_ERROR_TYPE } from "@opentelemetry/semantic-conventions";
import { diagnostics } from "./diagnostics.js";
import { exceptionType } from "./http/interceptor.js";
import { getStateFromContext, maybeFault } from "./http/request-state.js";
import { TRACER_NAME } from "./http/server.js";
import { endNestrixSpan, startNestrixSpan } from "./trace-limit.js";

const EVENT = "uncaughtExceptionMonitor";

let users = 0;

function asException(
  error: unknown,
): Error | { name: string; message: string } {
  if (error instanceof Error) return error;
  let message: string;
  try {
    message = String(error);
  } catch {
    message = "(unprintable)";
  }
  return { name: exceptionType(error), message };
}

/** The listener. Exported for tests. */
export function onUncaughtExceptionMonitor(
  error: unknown,
  origin: unknown,
): void {
  try {
    maybeFault("process-monitor");
    const active = context.active();
    const state = getStateFromContext(active);
    if (state && !state.ended) {
      state.span.recordException(asException(error));
      state.exception ??= { status: 500, type: exceptionType(error) };
      return;
    }
    const name =
      typeof origin === "string" && origin !== ""
        ? origin
        : "uncaughtException";
    const span = startNestrixSpan(
      trace.getTracer(TRACER_NAME),
      name,
      { kind: SpanKind.INTERNAL },
      active,
    );
    span.recordException(asException(error));
    span.setAttribute(ATTR_ERROR_TYPE, exceptionType(error));
    span.setStatus({ code: SpanStatusCode.ERROR });
    endNestrixSpan(span);
  } catch (failure) {
    diagnostics.countFailure("process.uncaught-exception-monitor", failure);
  }
}

/**
 * Adds the monitor (once per process, however many apps install it) and returns a disposer that
 * removes it when the last app shuts down. Never throws.
 */
export function installProcessErrorMonitor(): () => void {
  try {
    if (users === 0) process.on(EVENT, onUncaughtExceptionMonitor);
    users++;
  } catch (error) {
    diagnostics.countFailure("process.install", error);
    return () => undefined;
  }
  let disposed = false;
  return () => {
    try {
      if (disposed) return;
      disposed = true;
      users--;
      if (users === 0) process.off(EVENT, onUncaughtExceptionMonitor);
    } catch (error) {
      diagnostics.countFailure("process.uninstall", error);
    }
  };
}
