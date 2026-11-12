/**
 * Where `NestrixLogger` hands records. Module-level slots because the logger is usually created
 * before the Nest module exists (`NestFactory.create(AppModule, { logger: new NestrixLogger() })`):
 *
 * - the export slot: filled by `NestrixCore` when `logs.export` is on and the packages loaded
 *   (OTLP export);
 * - the trace slot: filled by the dashboard's trace store while an app with the dashboard on is
 *   attached (P9-07: log lines kept next to their trace).
 *
 * Both empty means: print only.
 */
import type { LogLevel } from "@nestjs/common";

export interface LogRecordInput {
  level: LogLevel;
  body: string;
  /** Nest's logger context (usually the class name). */
  context: string | undefined;
  /** The stack of an `error` or `fatal` call, when given. */
  stack: string | undefined;
}

export interface LogSink {
  /** May throw; the caller guards it. */
  emit(record: LogRecordInput): void;
}

/** A record for the trace slot: written while a recording span was active. */
export interface TraceLogInput {
  traceId: string;
  spanId: string;
  timeUnixMs: number;
  level: LogLevel;
  /** Already through the logger's `redact` and cut to `MAX_BODY_LENGTH`. */
  body: string;
  context: string | undefined;
}

export interface TraceLogSink {
  /** May throw; the caller guards it. */
  add(record: TraceLogInput): void;
}

let sink: LogSink | undefined;
let traceSink: TraceLogSink | undefined;

export function getLogSink(): LogSink | undefined {
  return sink;
}

export function setLogSink(next: LogSink | undefined): void {
  sink = next;
}

export function getTraceLogSink(): TraceLogSink | undefined {
  return traceSink;
}

export function setTraceLogSink(next: TraceLogSink | undefined): void {
  traceSink = next;
}
