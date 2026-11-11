import { ConsoleLogger, type LogLevel } from "@nestjs/common";
import { diagnostics } from "../diagnostics.js";
import { getLogSink } from "./sink.js";
import { getTraceIds } from "./trace-ids.js";

type JsonLogObject = ReturnType<ConsoleLogger["getJsonLogObject"]>;
type JsonLogOptions = Parameters<ConsoleLogger["getJsonLogObject"]>[1];

function bodyOf(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message) ?? String(message);
  } catch {
    return String(message);
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
    try {
      const sink = getLogSink();
      if (sink) {
        const stack = typeof errorStack === "string" ? errorStack : undefined;
        for (const message of messages) {
          sink.emit({
            level: logLevel,
            body: bodyOf(this.resolveMessage(message)),
            context: context || undefined,
            stack,
          });
        }
      }
    } catch (error) {
      diagnostics.countFailure("logs.emit", error);
    }
    super.printMessages(
      messages,
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
