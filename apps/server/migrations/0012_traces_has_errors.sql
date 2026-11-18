-- `TraceSummary.hasErrors` (issue #23, D-94): any span of the trace failed (status error, unless
-- every exception on it is expected), whatever the root's outcome: a failed job, or an error
-- recorded on a child span of a request that answered 200. Set with OR semantics by the per-trace
-- upsert (src/storage/traces.ts).
--
-- Nullable with no default, so adding it rewrites nothing. Existing rows keep NULL; the query
-- reads `coalesce(has_errors, error_count > 0)` for them (any error span, expected ones included),
-- and a row that receives new spans gets the exact flag merged with that fallback.
ALTER TABLE traces ADD COLUMN has_errors boolean;
