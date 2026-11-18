/**
 * The error-occurrence rules of `storage/error-facts.ts` (D-93, D-94) as SQL over a `spans` row,
 * for the error list, the error groups and the error insights.
 *
 * Rows stored since migration 0012 carry the rule's result, derived at ingest (`derive.ts`):
 * `is_occurrence` (status error, and no exception event or a primary one) and `error_key` (a hash
 * of the primary exception's type, message and stack trace). The legacy parent rule then only
 * compares keys: with a window start (`from`, the aggregates) as one hashed anti-join over the
 * window's error children; without one (the paged list) as an index probe on `spans_parent_idx`
 * bounded by `c.start_time >= s.start_time`, so Postgres prunes older partitions at run time. A
 * child starts after its parent; one whose clock runs ahead of the parent's across services is
 * simply not matched.
 *
 * Rows stored before 0012 (`is_occurrence IS NULL`) are read from their `events` JSON with
 * `jsonb_path_*` (the marks are booleans, or the string "true" when an exporter stringified them).
 * That is slower, and only until they age out of the retention window.
 */
import {
  ATTR_EXCEPTION_EXPECTED,
  ATTR_EXCEPTION_PROPAGATED,
} from "../storage/error-facts.js";

const marked = (key: string) =>
  `(@.attributes."${key}" == true || @.attributes."${key}" == "true")`;

/** Every exception event. */
const EXCEPTION_PATH = `$[*] ? (@.name == "exception")`;
/** Exception events neither propagated nor expected; the first one is the primary. */
const PRIMARY_PATH = `$[*] ? (@.name == "exception" && !${marked(ATTR_EXCEPTION_PROPAGATED)} && !${marked(ATTR_EXCEPTION_EXPECTED)})`;

const IDENTITY = [
  "exception.type",
  "exception.message",
  "exception.stacktrace",
] as const;

function primaryAttributes(s: string): string {
  return `(jsonb_path_query_first(${s}.events, '${PRIMARY_PATH}') -> 'attributes')`;
}

/** Before the legacy rule, from the events JSON (rows stored before migration 0012). */
function occurrenceFromEvents(s: string): string {
  return `(NOT jsonb_path_exists(${s}.events, '${EXCEPTION_PATH}') OR jsonb_path_exists(${s}.events, '${PRIMARY_PATH}'))`;
}

/** The legacy parent rule from the events JSON (rows stored before migration 0012). */
function legacyFromEvents(s: string): string {
  const same = IDENTITY.map(
    (k) =>
      `${primaryAttributes("c")} -> '${k}' IS NOT DISTINCT FROM ${primaryAttributes(s)} -> '${k}'`,
  ).join(" AND ");
  return `(NOT jsonb_path_exists(${s}.events, '${PRIMARY_PATH}') OR NOT EXISTS (
      SELECT 1 FROM spans c
       WHERE c.trace_id = ${s}.trace_id AND c.parent_span_id = ${s}.span_id
         AND c.start_time >= ${s}.start_time AND c.is_error
         AND jsonb_path_exists(c.events, '${PRIMARY_PATH}') AND ${same}))`;
}

/**
 * Span alias `s` is an error occurrence: status `error`, no exception event or a primary one, and
 * no direct child that is an error with the same primary exception. `from` (a SQL expression,
 * usually a bound parameter) is the start of the window the caller reads `s` from, when it has
 * one: children are looked for from there, which lets Postgres prune partitions and run the
 * legacy rule as one hash anti-join. The `NOT EXISTS` must stay a top-level conjunct of the
 * caller's `WHERE` for that, so this is a conjunction, not a `CASE`.
 */
export function occurrenceSql(s: string, from?: string): string {
  const bound =
    from === undefined
      ? `c.start_time >= ${s}.start_time`
      : `c.start_time >= ${from} AND c.start_time >= ${s}.start_time`;
  return `${s}.is_error
    AND coalesce(${s}.is_occurrence, ${occurrenceFromEvents(s)})
    AND NOT EXISTS (
      SELECT 1 FROM spans c
       WHERE c.trace_id = ${s}.trace_id AND c.parent_span_id = ${s}.span_id AND ${bound}
         AND c.is_error AND c.error_key = ${s}.error_key)
    AND (${s}.is_occurrence IS NOT NULL OR ${legacyFromEvents(s)})`;
}

/**
 * `traces.has_errors` with the fallback for rows stored before migration 0012 (`NULL`: any error
 * span), or the root's own error (D-94). Written exactly as the predicate of the partial index
 * `traces_has_errors_seq_idx` (migration 0012), so the planner can use it.
 */
export const TRACE_HAS_ERRORS_SQL =
  "(coalesce(has_errors, error_count > 0) OR is_error)";
