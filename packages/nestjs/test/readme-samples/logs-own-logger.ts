import { ConsoleLogger, type LogLevel } from "@nestjs/common";
import { emitLog } from "../../src/index.js";

/** Your own logger: masks tokens, prints as usual, and hands each line to Nestrix. */
export class AppLogger extends ConsoleLogger {
  protected override printMessages(
    messages: unknown[],
    context?: string,
    logLevel: LogLevel = "log",
    writeStreamType?: "stdout" | "stderr",
    errorStack?: unknown,
    params?: Record<string, unknown>,
  ): void {
    const safe = messages.map((m) => maskTokens(this.resolveMessage(m)));
    for (const message of safe) {
      // this.redact applies ConsoleLogger's own `redact` option before export.
      emitLog({
        level: logLevel,
        message: this.redact(message),
        context,
        error: errorStack,
      });
    }
    super.printMessages(
      safe,
      context,
      logLevel,
      writeStreamType,
      errorStack,
      params,
    );
  }
}

function maskTokens(message: unknown): unknown {
  return typeof message === "string"
    ? message.replace(/token=\S+/g, "token=[REDACTED]")
    : message;
}
