-- `traces?hasErrors=true` lists newest first (D-94): a partial index on seq with the query's exact
-- predicate (`TRACE_HAS_ERRORS_SQL` in src/query/error-sql.ts), as `traces_has_job_seq_idx` does
-- for jobs. Created on the partitioned parent, so it applies to the existing partitions and to
-- every later one.
--
-- Locks: a partitioned table's index cannot be built CONCURRENTLY, so this takes a SHARE lock on
-- `traces` and on each partition while its index builds, held until this file's transaction
-- commits: reads of `traces` go on, writes (the ingest's trace upsert) wait. `spans` is not
-- touched. A large install can pre-build the index without blocking writes (apps/server/README.md,
-- upgrade notes): per partition CREATE INDEX CONCURRENTLY, then CREATE INDEX
-- traces_has_errors_seq_idx ON ONLY traces (...), then ALTER INDEX ... ATTACH PARTITION for each.
-- This statement is IF NOT EXISTS, so it then does nothing.
CREATE INDEX IF NOT EXISTS traces_has_errors_seq_idx ON traces (seq DESC)
  WHERE (coalesce(has_errors, error_count > 0) OR is_error);
