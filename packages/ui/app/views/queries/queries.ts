import type { QueryStatement } from "@nestrix-js/protocol";

/** The columns the server sorts by (`sort=`); the other columns are not sortable. */
export const SORT_KEYS = ["total", "count", "p95", "max"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const DEFAULT_SORT: SortKey = "total";

/** Characters of a statement shown before it is cut; the full text is one click away. */
export const PREVIEW_CHARS = 120;

/** The statement as shown collapsed: whitespace folded to single spaces, cut with an ellipsis. */
export function preview(statement: string): string {
  const flat = statement.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS
    ? `${flat.slice(0, PREVIEW_CHARS)}…`
    : flat;
}

export function isTruncated(statement: string): boolean {
  return statement.replace(/\s+/g, " ").trim().length > PREVIEW_CHARS;
}

/** N+1 candidates: statements that ran 3 or more times within at least one trace. */
export function onlyRepeated(
  queries: readonly QueryStatement[],
  enabled: boolean,
): QueryStatement[] {
  return enabled ? queries.filter((q) => q.repeatedTraces > 0) : [...queries];
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Statements whose text contains `text` (whitespace folded, case-insensitive); all for none. */
export function filterByText(
  queries: readonly QueryStatement[],
  text: string | null,
): QueryStatement[] {
  if (text === null || flat(text) === "") return [...queries];
  const needle = flat(text);
  return queries.filter((q) => flat(q.statement).includes(needle));
}

/** Characters of a statement used as a chart label; the full text is the tooltip. */
export const LABEL_CHARS = 56;

/** A statement cut to `max` characters for a chart label, whitespace folded. */
export function shortStatement(statement: string, max = LABEL_CHARS): string {
  const folded = statement.replace(/\s+/g, " ").trim();
  return folded.length > max ? `${folded.slice(0, max)}…` : folded;
}

/** The `n` statements with the largest `key`, largest first; statements with none are left out. */
export function topBy(
  queries: readonly QueryStatement[],
  key: "avgMs" | "count",
  n = 6,
): QueryStatement[] {
  return queries
    .filter((q) => q[key] > 0)
    .sort((a, b) => b[key] - a[key])
    .slice(0, n);
}

/** Average executions per trace in which the statement ran: 1 for a statement that runs once. */
export function callsPerTrace(
  q: Pick<QueryStatement, "count" | "traces">,
): number {
  return q.traces > 0 ? q.count / q.traces : q.count;
}

/** "1", "4.2", "12": calls per trace with one decimal below 10. */
export function formatPerTrace(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return value < 10
    ? value.toFixed(1).replace(/\.0$/, "")
    : String(Math.round(value));
}

export interface QuerySummary {
  statements: number;
  totalMs: number;
  /** Statements that ran 3 or more times within one trace. */
  nPlusOne: number;
  /** The statement with the highest mean duration; none for an empty list. */
  slowest: QueryStatement | null;
}

export function summarizeQueries(
  queries: readonly QueryStatement[],
): QuerySummary {
  let slowest: QueryStatement | null = null;
  let totalMs = 0;
  let nPlusOne = 0;
  for (const q of queries) {
    totalMs += q.totalMs;
    if (q.repeatedTraces > 0) nPlusOne += 1;
    if (slowest === null || q.avgMs > slowest.avgMs) slowest = q;
  }
  return { statements: queries.length, totalMs, nPlusOne, slowest };
}
