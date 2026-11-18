-- Searchable logs (issue #17, D-106). Additive: nothing here changes what the trace view reads.
--
-- * `logs.truncated`: the body was cut to 8,192 characters. A constant default, so no rewrite.
-- * `logs.trace_id = ''` is a line without a trace (NESTRIX_LOGS=all only); the column stays NOT
--   NULL because it is part of the primary key.
-- * `log_drops`: lines not stored, per UTC day and reason (trace_cap, rate_cap, out_of_range),
--   shown next to the search results. Pruned with the log retention by the writer's maintenance.
-- * The indexes for `GET api/v1/logs` are in 0022_logs_search_indexes.sql, a separate file (and so
--   a separate transaction) on purpose.
--
-- Locks: `ADD COLUMN` takes an ACCESS EXCLUSIVE lock on `logs` and its partitions. It rewrites
-- nothing and this transaction does nothing slow, so it commits at once; it waits for queries
-- already running on `logs` to finish, and new ones queue behind it for that moment. Keeping the
-- index builds out of this transaction is what stops that lock being held while they run.
ALTER TABLE logs ADD COLUMN IF NOT EXISTS truncated boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS log_drops (
  day date NOT NULL,
  reason text NOT NULL,
  dropped bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, reason)
);
