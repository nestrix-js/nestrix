import { ConsoleLogger, type LogLevel } from "@nestjs/common";
import { diagnostics } from "../diagnostics.js";
import { emitMessages } from "./emit.js";
import { getTraceIds } from "./trace-ids.js";

export { MAX_BODY_LENGTH } from "./emit.js";

type JsonLogObject = ReturnType<ConsoleLogger["getJsonLogObject"]>;
type JsonLogOptions = Parameters<ConsoleLogger["getJsonLogObject"]>[1];

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
      emitMessages(
        logLevel,
        resolved,
        context || undefined,
        typeof errorStack === "string" ? errorStack : undefined,
        undefined,
        (r) => this.redact(r),
      );
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
