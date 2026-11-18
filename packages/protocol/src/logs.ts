/**
 * Log lines kept next to a trace (docs/backlog/phase-9.md P9-07). Types only: this file adds no
 * runtime export.
 *
 * Logs are context for a trace, not a log backend: only records that carry a trace id are kept,
 * at most 200 per trace, evicted or expired with the trace, and there is no
 * search across them.
 *
 * Route, under the API base, on both backends:
 * - `GET api/v1/trace/logs?id=<32 lowercase hex>` (parameters: `TraceParamsSpec`): `TraceLogsResponse`.
 *   A trace with no kept log lines (or not stored at all) answers `200` with no items.
 *
 * Sources:
 * - Embedded: records written through `NestrixLogger` while a recording span is active, when the
 *   dashboard is on. The message has been through the logger's own `redact` option and is cut to
 *   8,192 characters (ending in `…`).
 * - Standalone: OTLP log records received on `POST /v1/logs` that carry a valid trace id. The
 *   body is cut to 8,192 characters.
 */

/** One log line of a trace. */
export interface TraceLogRecord {
  /** When the line was written (OTLP `time_unix_nano`, else `observed_time_unix_nano`). */
  timeUnixMs: number;
  /**
   * OTLP `SeverityNumber`: 1-4 trace, 5-8 debug, 9-12 info, 13-16 warn, 17-20 error, 21-24 fatal,
   * 0 unspecified. The embedded dashboard maps Nest's levels: verbose 1, debug 5, log 9, warn 13,
   * error 17, fatal 21.
   */
  severity: number;
  /** The level as written: Nest's level name (embedded) or OTLP `severity_text` (may be empty). */
  level: string;
  /** Nest's logger context (usually a class name), from the `nestrix.log.context` attribute. */
  context?: string;
  /** The message (OTLP body as text), cut to 8,192 characters. */
  message: string;
  /** The span active when the line was written, when there was one. */
  spanId?: string;
  /** `service.name` of the record's resource (standalone only). */
  service?: string;
}

/**
 * Log search, standalone server only (issue #17, D-106; the embedded dashboard has no such route).
 *
 * - `GET api/v1/logs` (parameters: `LogSearchParamsSpec`): `LogSearchResponse`, newest first,
 *   paged with `before` (the previous page's `older`). The window defaults to the last 24 hours.
 *   `text` is a full text search over the stored message (`match=words`, the default: whole words,
 *   `websearch` syntax with quotes, `or` and `-`) or a case-insensitive substring
 *   (`match=substring`, a scan of the time window). `severity` is a minimum level.
 * - What is stored depends on the server's `NESTRIX_LOGS`: `trace` (default) keeps only lines
 *   with a trace id, 200 per trace; `all` also keeps lines without one. Search reads whatever is
 *   stored in either mode.
 */
export interface LogSearchRecord {
  /** Milliseconds, fractional part kept. */
  timeUnixMs: number;
  /** Exact time as a decimal string of nanoseconds. */
  timeUnixNano: string;
  /** OTLP `SeverityNumber`, as in `TraceLogRecord`. */
  severity: number;
  level: string;
  context?: string;
  /** Cut to 8,192 characters; see `truncated`. */
  message: string;
  service: string;
  /** Absent for a line written outside any trace. */
  traceId?: string;
  spanId?: string;
  /** Whether the trace is stored (a link to it works). Absent when there is no `traceId`. */
  traceExists?: boolean;
  /** The message was longer than 8,192 characters and was cut. */
  truncated: boolean;
}

/** Lines not stored, for the days the search window touches. */
export interface LogSearchDropped {
  total: number;
  /** `all` mode: more than `NESTRIX_LOGS_MAX_PER_MINUTE` lines in a minute. */
  rateCap: number;
  /** A trace already held its per-trace maximum. */
  traceCap: number;
  /** Older than the log retention or too far ahead. */
  outOfRange: number;
}

export interface LogSearchResponse {
  items: LogSearchRecord[];
  /** Cursor for the next (older) page, `null` on the last. */
  older: string | null;
  /** The server's `NESTRIX_LOGS` setting. */
  capture: "trace" | "all";
  dropped: LogSearchDropped;
}

/** `GET api/v1/trace/logs`. */
export interface TraceLogsResponse {
  traceId: string;
  /** Oldest first; at most 200. */
  items: TraceLogRecord[];
  /** More lines were written for this trace than are kept (the per-trace cap was reached). */
  truncated: boolean;
}
