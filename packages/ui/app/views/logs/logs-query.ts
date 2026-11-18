import type { LogSearchDropped } from "@nestrix-js/protocol";

import type { QueryParams } from "@/lib/api";

/** Time ranges the page offers; the API default is the last 24 hours. */
export const LOG_WINDOWS = [
  { id: "15m", label: "15 minutes", ms: 15 * 60_000 },
  { id: "1h", label: "1 hour", ms: 3_600_000 },
  { id: "6h", label: "6 hours", ms: 6 * 3_600_000 },
  { id: "24h", label: "24 hours", ms: 24 * 3_600_000 },
  { id: "7d", label: "7 days", ms: 7 * 24 * 3_600_000 },
] as const;
export type LogWindowId = (typeof LOG_WINDOWS)[number]["id"];

export const LOG_SEVERITIES = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;

export interface LogFilters {
  text: string;
  match: "words" | "substring";
  severity: "" | (typeof LOG_SEVERITIES)[number];
  window: LogWindowId;
  service: string | undefined;
  traceId: string;
}

export const DEFAULT_LOG_FILTERS: LogFilters = {
  text: "",
  match: "words",
  severity: "",
  window: "1h",
  service: undefined,
  traceId: "",
};

const TRACE_ID = /^[0-9a-f]{32}$/;

/** The query for `GET api/v1/logs`: the window ends now (frozen by `nowMs`) so paging is stable. */
export function logQuery(filters: LogFilters, nowMs: number): QueryParams {
  const windowMs =
    LOG_WINDOWS.find((w) => w.id === filters.window)?.ms ?? 3_600_000;
  const traceId = filters.traceId.trim().toLowerCase();
  return {
    fromUnixMs: nowMs - windowMs,
    toUnixMs: nowMs,
    text: filters.text.trim() || undefined,
    match: filters.text.trim() ? filters.match : undefined,
    severity: filters.severity || undefined,
    service: filters.service,
    traceId: TRACE_ID.test(traceId) ? traceId : undefined,
    limit: 100,
  };
}

export function isTraceId(value: string): boolean {
  return value === "" || TRACE_ID.test(value.trim().toLowerCase());
}

/** "12 lines dropped (5 over the per-minute budget, ...)" or null when none. */
export function dropSummary(d: LogSearchDropped): string | null {
  if (d.total <= 0) return null;
  const parts: string[] = [];
  if (d.rateCap > 0) parts.push(`${d.rateCap} over the per-minute budget`);
  if (d.traceCap > 0) parts.push(`${d.traceCap} over the per-trace maximum`);
  if (d.outOfRange > 0) parts.push(`${d.outOfRange} outside the retention`);
  return `${d.total} ${d.total === 1 ? "line" : "lines"} dropped (${parts.join(", ")})`;
}

/** `12:04:31.482` in the browser's time zone. */
export function logClock(unixMs: number): string {
  const d = new Date(unixMs);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
