-- Searchable logs (issue #17, D-106). Additive: nothing here changes what the trace view reads.
--
-- * `logs.truncated`: the body was cut to 8,192 characters. A constant default, so no rewrite.
-- * `logs.trace_id = ''` is a line without a trace (NESTRIX_LOGS=all only); the column stays NOT
--   NULL because it is part of the primary key.
-- * Indexes for `GET api/v1/logs` (newest first by time_ns, trace_id, record_hash, the cursor):
--   time, service + time, errors only, and PostgreSQL's built-in full text search over the body
--   (no extension: `pg_trgm` is not guaranteed). Substring search (`match=substring`) is an ILIKE
--   over the time-bounded scan.
-- * `log_drops`: lines not stored, per UTC day and reason (trace_cap, rate_cap, out_of_range),
--   shown next to the search results. Pruned with the log retention by the writer's maintenance.
--
-- Locks: a partitioned table's index cannot be built CONCURRENTLY, so each CREATE INDEX takes a
-- SHARE lock on `logs` and its partitions until this file's transaction commits: reads go on, log
-- writes wait (span ingest is not touched; a log export waits or answers 503 and is retried). A
-- large install can pre-build them without blocking writes (apps/server/README.md, upgrade
-- notes): per partition CREATE INDEX CONCURRENTLY, then CREATE INDEX ... ON ONLY logs, then ALTER
-- INDEX ... ATTACH PARTITION for each. These statements are IF NOT EXISTS, so they then do nothing.
ALTER TABLE logs ADD COLUMN IF NOT EXISTS truncated boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS logs_time_idx
  ON logs (time_ns DESC, trace_id DESC, record_hash DESC);
CREATE INDEX IF NOT EXISTS logs_service_time_idx
  ON logs (service_name, time_ns DESC, trace_id DESC, record_hash DESC);
CREATE INDEX IF NOT EXISTS logs_errors_time_idx
  ON logs (time_ns DESC, trace_id DESC, record_hash DESC) WHERE severity_number >= 17;
CREATE INDEX IF NOT EXISTS logs_body_fts_idx
  ON logs USING gin (to_tsvector('simple', body));

CREATE TABLE IF NOT EXISTS log_drops (
  day date NOT NULL,
  reason text NOT NULL,
  dropped bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, reason)
);
