import { isSpanContextValid, trace } from "@opentelemetry/api";

/** The ids of the active span, as lowercase hex. */
export interface TraceIds {
  traceId: string;
  spanId: string;
}

/**
 * The trace and span id of the span active right now, or `undefined` when there is none (or
 * its context is invalid). For loggers that take extra fields: pino's `mixin`, winston's
 * format, `nestjs-pino`. Never throws.
 */
export function getTraceIds(): TraceIds | undefined {
  try {
    const span = trace.getActiveSpan();
    if (!span) return undefined;
    const spanContext = span.spanContext();
    return isSpanContextValid(spanContext)
      ? { traceId: spanContext.traceId, spanId: spanContext.spanId }
      : undefined;
  } catch {
    return undefined;
  }
}
