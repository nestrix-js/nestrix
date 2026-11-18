/**
 * The error-occurrence rules of `storage/error-facts.ts` (D-93, D-94) as SQL over a `spans` row,
 * for the error list, the error groups and the error insights. Evaluated at query time from the
 * stored `events` JSON, so rows stored before these rules are read the same way.
 *
 * `jsonb_path_*` with a constant path: the marks are booleans (`true`), or the string `"true"`
 * when an exporter stringified them.
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

/** The primary exception event of span alias `s`, as `jsonb` (SQL `NULL` when none). */
export function primarySql(s: string): string {
  return `jsonb_path_query_first(${s}.events, '${PRIMARY_PATH}')`;
}

/** type, message and stack trace of the primary exception of `s` (the legacy parent rule's key). */
function keySql(s: string): string {
  const p = primarySql(s);
  return `jsonb_build_array(${p} -> 'attributes' -> 'exception.type', ${p} -> 'attributes' -> 'exception.message', ${p} -> 'attributes' -> 'exception.stacktrace')`;
}

/**
 * Span alias `s` is an error occurrence: status `error`, and no exception event or a primary one,
 * and no direct child that is an error with the same primary exception (spans from SDKs that do
 * not mark propagation; served by `spans_parent_idx`).
 */
export function occurrenceSql(s: string): string {
  return `(${s}.is_error
    AND (NOT jsonb_path_exists(${s}.events, '${EXCEPTION_PATH}') OR jsonb_path_exists(${s}.events, '${PRIMARY_PATH}'))
    AND NOT (${primarySql(s)} IS NOT NULL AND EXISTS (
      SELECT 1 FROM spans c
       WHERE c.trace_id = ${s}.trace_id AND c.parent_span_id = ${s}.span_id AND c.is_error
         AND ${primarySql("c")} IS NOT NULL AND ${keySql("c")} = ${keySql(s)})))`;
}

/**
 * `traces.has_errors` with the fallback for rows stored before migration 0012 (`NULL`: any error
 * span), or the root's own error (D-94).
 */
export const TRACE_HAS_ERRORS_SQL =
  "(coalesce(has_errors, error_count > 0) OR is_error)";
