/**
 * Where `NestrixLogger` hands records for OTLP export. A module-level slot because the
 * logger is usually created before the Nest module exists (`NestFactory.create(AppModule,
 * { logger: new NestrixLogger() })`); `NestrixCore` fills the slot when `logs.export` is on
 * and the packages loaded. Empty means: print only.
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

let sink: LogSink | undefined;

export function getLogSink(): LogSink | undefined {
  return sink;
}

export function setLogSink(next: LogSink | undefined): void {
  sink = next;
}
