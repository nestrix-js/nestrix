/**
 * The one path every log record takes into Nestrix: `NestrixLogger` and the public `emitLog()`
 * (D-75, D-89). It applies the same rules to both: the trace store takes a line only while a
 * recording span is active, the body is cut to `MAX_BODY_LENGTH`, OTLP export runs only when
 * `logs.export` filled the export slot, and nothing here throws.
 */
import type { LogLevel } from "@nestjs/common";
import {
  type Attributes,
  isSpanContextValid,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { diagnostics } from "../diagnostics.js";
import { holdTraceLog } from "../tail-sampling.js";
import { getLogSink, getTraceLogSink, type TraceLogSink } from "./sink.js";
import type { TraceIds } from "./trace-ids.js";

/** The longest body sent over OTLP; longer ones are cut and end in `…`. */
export const MAX_BODY_LENGTH = 8192;

const LEVELS: ReadonlySet<string> = new Set<LogLevel>([
  "verbose",
  "debug",
  "log",
  "warn",
  "error",
  "fatal",
]);

/** One record for `emitLog()`. */
export interface NestrixLogRecord {
  /** Nest's level. Anything else is recorded as `'log'`. */
  level: LogLevel;
  /**
   * The message, already redacted by your logger: Nestrix sends it as given (a string as is, an
   * `Error` as its `message`, anything else as JSON), cut to 8,192 characters.
   */
  message: unknown;
  /** The logger context (usually the class name), sent as `nestrix.log.context`. */
  context?: string;
  /**
   * An `Error` (its `stack` is sent) or a stack string, as Nest's `logger.error(message, stack)`
   * passes it. Sent over OTLP as `exception.stacktrace`; never kept in the dashboard's store.
   */
  error?: unknown;
  /** Extra OTLP attributes for this record. Exported only; the dashboard's store drops them. */
  attributes?: Attributes;
}

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
function recordingIds(): TargetIds | undefined {
  const span = trace.getActiveSpan();
  if (!span?.isRecording()) return undefined;
  const spanContext = span.spanContext();
  return isSpanContextValid(spanContext)
    ? {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        sampled: (spanContext.traceFlags & TraceFlags.SAMPLED) !== 0,
      }
    : undefined;
}

/** The active span's ids and whether its trace flags say sampled (else it records for the tail decision). */
type TargetIds = TraceIds & { sampled: boolean };

/** Set while records are handed to the trace slot, so a line logged on that path is not fed back. */
let addingToTrace = false;

/** The active recording span's ids when the store takes lines now; `undefined` otherwise. Never throws. */
function traceTarget(
  traceSink: TraceLogSink | undefined,
): TargetIds | undefined {
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
  target: TargetIds,
  level: LogLevel,
  bodies: readonly string[],
  context: string | undefined,
): void {
  if (addingToTrace) return;
  addingToTrace = true;
  try {
    const timeUnixMs = Date.now();
    const ids = { traceId: target.traceId, spanId: target.spanId };
    for (const body of bodies) {
      const record = { ...ids, timeUnixMs, level, body, context };
      // Below sampleRate 1 a recording span may belong to a trace that is still undecided (D-100):
      // its lines wait in the tail registry and reach the store only if the trace is kept.
      if (!target.sampled) {
        const outcome = holdTraceLog(record);
        if (outcome === "held" || outcome === "drop") continue;
      }
      traceSink.add(record);
    }
  } catch (error) {
    diagnostics.countFailure("logs.trace", error);
  } finally {
    addingToTrace = false;
  }
}

/**
 * Sends `messages` (one record each) to the trace store and the export slot. `prepare` runs on
 * each message only when one of them takes it (`NestrixLogger` passes its `redact`). May throw
 * only from `prepare`; the callers guard it.
 */
export function emitMessages(
  level: LogLevel,
  messages: readonly unknown[],
  context: string | undefined,
  stack: string | undefined,
  attributes: Attributes | undefined,
  prepare?: (message: unknown) => unknown,
): void {
  const sink = getLogSink();
  const traceSink = getTraceLogSink();
  if (sink === undefined && traceSink === undefined) return;
  const ids = traceTarget(traceSink);
  if (!sink && !ids) return;
  const bodies = messages.map((m) => bodyOf(prepare ? prepare(m) : m));
  if (traceSink && ids) addToTrace(traceSink, ids, level, bodies, context);
  if (sink) {
    for (const body of bodies) {
      sink.emit({ level, body, context, stack, attributes });
    }
  }
}

function stackOf(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (error instanceof Error && typeof error.stack === "string") {
    return error.stack;
  }
  return undefined;
}

/**
 * Sends one log record from your own logger through the same path as `NestrixLogger`: kept next
 * to its trace in the dashboard while a recording span is active, and exported over OTLP to
 * `/v1/logs` when `logs.export` is on, with the active span's trace and span id. It prints
 * nothing and does not redact the message: call it from your logger's print path with the message
 * your logger already redacted. `attributes` get Nestrix's built-in scrub rule before export
 * (D-112: always-redacted headers, listed query keys and `url.full` credentials), not the `redact`
 * hook. Never throws. With Nestrix disabled, or with neither the dashboard nor log
 * export on, it returns after two slot reads.
 */
export function emitLog(record: NestrixLogRecord): void {
  if (getLogSink() === undefined && getTraceLogSink() === undefined) return;
  try {
    const level: LogLevel = LEVELS.has(record.level) ? record.level : "log";
    emitMessages(
      level,
      [record.message],
      typeof record.context === "string" && record.context !== ""
        ? record.context
        : undefined,
      stackOf(record.error),
      record.attributes,
    );
  } catch (error) {
    diagnostics.countFailure("logs.emit", error);
  }
}
