import { ConsoleLogger, type LogLevel } from "@nestjs/common";
import { isSpanContextValid, trace } from "@opentelemetry/api";
import { diagnostics } from "../diagnostics.js";
import { getLogSink, getTraceLogSink, type TraceLogSink } from "./sink.js";
import { getTraceIds, type TraceIds } from "./trace-ids.js";

type JsonLogObject = ReturnType<ConsoleLogger["getJsonLogObject"]>;
type JsonLogOptions = Parameters<ConsoleLogger["getJsonLogObject"]>[1];

/** The longest body sent over OTLP; longer ones are cut and end in `…`. */
export const MAX_BODY_LENGTH = 8192;

function rawBodyOf(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message) ?? String(message);
  } catch {
    return String(message);
  }
}

function bodyOf(message: unknown): string {
  const body = rawBodyOf(message);
  return body.length > MAX_BODY_LENGTH
    ? `${body.slice(0, MAX_BODY_LENGTH)}…`
    : body;
}

/**
 * The ids of the active span when it is recording: a line written under a sampled-out span
 * would be kept for a trace the store never receives.
 */
function recordingIds(): TraceIds | undefined {
  const span = trace.getActiveSpan();
  if (!span?.isRecording()) return undefined;
  const spanContext = span.spanContext();
  return isSpanContextValid(spanContext)
    ? { traceId: spanContext.traceId, spanId: spanContext.spanId }
    : undefined;
}

/** Set while records are handed to the trace slot, so a line logged on that path is not fed back. */
let addingToTrace = false;

/** The active recording span's ids when the store takes lines now; `undefined` otherwise. Never throws. */
function traceTarget(
  traceSink: TraceLogSink | undefined,
): TraceIds | undefined {
  if (traceSink === undefined || addingToTrace) return undefined;
  try {
    return recordingIds();
  } catch (error) {
    diagnostics.countFailure("logs.trace", error);
    return undefined;
  }
}

/** Hands the lines to the dashboard store. Never throws. */
function addToTrace(
  traceSink: TraceLogSink,
  ids: TraceIds,
  level: LogLevel,
  bodies: readonly string[],
  context: string | undefined,
): void {
  if (addingToTrace) return;
  addingToTrace = true;
  try {
    const timeUnixMs = Date.now();
    for (const body of bodies) {
      traceSink.add({ ...ids, timeUnixMs, level, body, context });
    }
  } catch (error) {
    diagnostics.countFailure("logs.trace", error);
  } finally {
    addingToTrace = false;
  }
}

/**
 * Nest's `ConsoleLogger` with the active trace and span id on every line, and, when
 * `logs.export` is on, every record also sent over OTLP. Nothing is patched: pass it as
 * `NestFactory.create(AppModule, { logger: new NestrixLogger() })` or `app.useLogger(...)`.
 *
 * Text lines end with ` trace_id=… span_id=…` while a span is active; JSON lines get
 * `trace_id` and `span_id` fields. Outside a span the output is `ConsoleLogger`'s. A failure
 * in correlation or export is counted and the line prints as usual.
 *
 * When the dashboard is on, a line written while a recording span is active is also kept in
 * the dashboard's store next to its trace (after `redact`, cut to `MAX_BODY_LENGTH`).
 */
export class NestrixLogger extends ConsoleLogger {
  protected override printMessages(
    messages: unknown[],
    context?: string,
    logLevel: LogLevel = "log",
    writeStreamType?: "stdout" | "stderr",
    errorStack?: unknown,
    params?: Record<string, unknown>,
  ): void {
    let toPrint = messages;
    try {
      const resolved = messages.map((m) => this.resolveMessage(m));
      toPrint = resolved;
      const sink = getLogSink();
      const traceSink = getTraceLogSink();
      const ids = traceTarget(traceSink);
      if (sink || ids) {
        const bodies = resolved.map((r) => bodyOf(this.redact(r)));
        if (traceSink && ids) {
          addToTrace(traceSink, ids, logLevel, bodies, context || undefined);
        }
        if (sink) {
          const stack = typeof errorStack === "string" ? errorStack : undefined;
          for (const body of bodies) {
            sink.emit({
              level: logLevel,
              body,
              context: context || undefined,
              stack,
            });
          }
        }
      }
    } catch (error) {
      diagnostics.countFailure("logs.emit", error);
    }
    super.printMessages(
      toPrint,
      context,
      logLevel,
      writeStreamType,
      errorStack,
      params,
    );
  }

  protected override formatMessage(
    ...args: Parameters<ConsoleLogger["formatMessage"]>
  ): string {
    const line = super.formatMessage(...args);
    try {
      const ids = getTraceIds();
      if (!ids) return line;
      const suffix = ` trace_id=${ids.traceId} span_id=${ids.spanId}`;
      return line.endsWith("\n")
        ? `${line.slice(0, -1)}${suffix}\n`
        : `${line}${suffix}`;
    } catch (error) {
      diagnostics.countFailure("logs.correlate", error);
      return line;
    }
  }

  protected override getJsonLogObject(
    message: unknown,
    options: JsonLogOptions,
  ): JsonLogObject {
    const record = super.getJsonLogObject(message, options);
    try {
      const ids = getTraceIds();
      if (ids) {
        record.trace_id = ids.traceId;
        record.span_id = ids.spanId;
      }
    } catch (error) {
      diagnostics.countFailure("logs.correlate", error);
    }
    return record;
  }
}
