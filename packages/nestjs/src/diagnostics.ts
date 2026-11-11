import { Logger } from "@nestjs/common";

/**
 * Nestrix's own logging and failure counting. Everything here is called from hooks and
 * subscribers, so nothing here may throw.
 */
export interface Diagnostics {
  /** Writes `message` through Nest's `Logger` (context `Nestrix`) once per `key` per process. */
  logOnce(key: string, message: string): void;
  /** Counts a failure at `where`; the first error of each `where` is logged once. */
  countFailure(where: string, error: unknown): void;
}

const LOG_CONTEXT = "Nestrix";

const loggedKeys = new Set<string>();
const failureCounts = new Map<string, number>();
let logger: Logger | undefined;

function getLogger(): Logger {
  logger ??= new Logger(LOG_CONTEXT);
  return logger;
}

function describeError(error: unknown): string {
  try {
    if (error instanceof Error) return error.stack ?? error.message;
    return String(error);
  } catch {
    return "(error could not be described)";
  }
}

function logOnce(key: string, message: string): void {
  try {
    if (loggedKeys.has(key)) return;
    loggedKeys.add(key);
    getLogger().log(message);
  } catch {
    // Diagnostics never throw.
  }
}

function countFailure(where: string, error: unknown): void {
  try {
    const next = (failureCounts.get(where) ?? 0) + 1;
    failureCounts.set(where, next);
    if (next === 1) {
      logOnce(
        `failure:${where}`,
        `Nestrix failed at "${where}" and carries on without it (further failures at this site are counted, not logged): ${describeError(error)}`,
      );
    }
  } catch {
    // Diagnostics never throw.
  }
}

/** The process-wide instance every Nestrix component uses. */
export const diagnostics: Diagnostics = { logOnce, countFailure };

/** Failure counts per site. Internal: for tests and the dashboard later, not public API. */
export function getFailureCounts(): ReadonlyMap<string, number> {
  return new Map(failureCounts);
}

/** Internal, for tests only: forget logged keys and counters. */
export function resetDiagnosticsForTests(): void {
  loggedKeys.clear();
  failureCounts.clear();
  logger = undefined;
}
