-- `TraceSummary.hasErrors` (issue #23, D-94): any span of the trace failed (status error, unless
-- every exception on it is expected), whatever the root's outcome: a failed job, or an error
-- recorded on a child span of a request that answered 200. Set with OR semantics by the per-trace
-- upsert (src/storage/traces.ts).
--
-- Nullable with no default, so adding it rewrites nothing. Existing rows keep NULL; the query
-- reads `coalesce(has_errors, error_count > 0)` for them (any error span, expected ones included),
-- and a row that receives new spans gets the exact flag merged with that fallback.
ALTER TABLE traces ADD COLUMN IF NOT EXISTS has_errors boolean;

-- Error occurrences (issue #22, D-93), derived at ingest so the error queries do not evaluate the
-- events JSON per row (src/storage/derive.ts, src/query/error-sql.ts): `is_occurrence` (status
-- error, and no exception event or one neither propagated nor expected) and `error_key` (a hash of
-- that exception's type, message and stack trace, for error spans). Nullable with no default: no
-- rewrite; rows stored before keep NULL and are read from their events JSON until they expire.
ALTER TABLE spans ADD COLUMN IF NOT EXISTS is_occurrence boolean;
ALTER TABLE spans ADD COLUMN IF NOT EXISTS error_key text;

-- `traces?hasErrors=true` lists newest first: a partial index on seq with the query's exact
-- predicate (`TRACE_HAS_ERRORS_SQL` in src/query/error-sql.ts), as `traces_has_job_seq_idx` does
-- for jobs. Created on the partitioned parent, so it applies to the existing partitions and to
-- every later one. A partitioned table's index cannot be built CONCURRENTLY, so ingest waits on
-- each partition while its index builds. A large install can pre-build it as for
-- `spans_parent_idx` (migration 0009, apps/server/README.md upgrade notes): per partition
-- CREATE INDEX CONCURRENTLY, then CREATE INDEX traces_has_errors_seq_idx ON ONLY traces (...),
-- then ALTER INDEX ... ATTACH PARTITION for each. This statement is IF NOT EXISTS, so it then
-- does nothing.
CREATE INDEX IF NOT EXISTS traces_has_errors_seq_idx ON traces (seq DESC)
  WHERE (coalesce(has_errors, error_count > 0) OR is_error);
