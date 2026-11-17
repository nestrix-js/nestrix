import type { LogLevel } from "@nestjs/common";
import pino from "pino";
import { emitLog } from "../../src/index.js";

const NEST_LEVEL: Record<number, LogLevel> = {
  10: "verbose",
  20: "debug",
  30: "log",
  40: "warn",
  50: "error",
  60: "fatal",
};

/** A pino destination: it gets each line after pino's `redact`, inside the caller's span. */
const toNestrix = {
  write(line: string): void {
    try {
      const { level, msg, context, err } = JSON.parse(line);
      emitLog({
        level: NEST_LEVEL[level] ?? "log",
        message: msg ?? line,
        context,
        error: err?.stack,
      });
    } catch {
      // Not JSON: not exported.
    }
  },
};

export const logger = pino(
  { redact: ["password", "*.password"] },
  pino.multistream([{ stream: process.stdout }, { stream: toNestrix }]),
);
