-- Indexes for `GET api/v1/logs` (issue #17, D-106): newest first by time_ns, trace_id,
-- record_hash (the cursor): time, service + time, errors only, and PostgreSQL's built-in full text
-- search over the body (no extension: `pg_trgm` is not guaranteed). Substring search
-- (`match=substring`) is an ILIKE over the time-bounded scan.
--
-- Locks: a partitioned table's index cannot be built CONCURRENTLY, so each CREATE INDEX takes a
-- SHARE lock on `logs` and on each partition, held until this file's transaction commits: reads of
-- `logs` (the search, the trace view) go on, log writes wait (a log export waits or answers 503
-- and is retried). Span ingest is not touched. This file takes no ACCESS EXCLUSIVE lock (that is
-- 0021's brief ADD COLUMN). A large install can pre-build the indexes without blocking writes
-- (apps/server/README.md, upgrade notes): per partition CREATE INDEX CONCURRENTLY, then CREATE
-- INDEX ... ON ONLY logs, then ALTER INDEX ... ATTACH PARTITION for each. These statements are
-- IF NOT EXISTS with the same names, so they then do nothing.
CREATE INDEX IF NOT EXISTS logs_time_idx
  ON logs (time_ns DESC, trace_id DESC, record_hash DESC);
CREATE INDEX IF NOT EXISTS logs_service_time_idx
  ON logs (service_name, time_ns DESC, trace_id DESC, record_hash DESC);
CREATE INDEX IF NOT EXISTS logs_errors_time_idx
  ON logs (time_ns DESC, trace_id DESC, record_hash DESC) WHERE severity_number >= 17;
CREATE INDEX IF NOT EXISTS logs_body_fts_idx
  ON logs USING gin (to_tsvector('simple', body));
