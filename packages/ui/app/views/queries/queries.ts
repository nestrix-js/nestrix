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
