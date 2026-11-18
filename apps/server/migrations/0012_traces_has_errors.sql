-- `TraceSummary.hasErrors` (issue #23, D-94): any span of the trace failed (status error, unless
-- every exception on it is expected), whatever the root's outcome: a failed job, or an error
-- recorded on a child span of a request that answered 200. Set with OR semantics by the per-trace
-- upsert (src/storage/traces.ts).
--
-- Nullable with no default, so adding it rewrites nothing. Existing rows keep NULL; the query
-- reads `coalesce(has_errors, error_count > 0)` for them (any error span, expected ones included),
-- and a row that receives new spans gets the exact flag merged with that fallback.
--
-- Locks: each ADD COLUMN takes an ACCESS EXCLUSIVE lock on the table and its partitions, held
-- until this file's transaction commits (src/storage/migrate.ts runs one transaction per file).
-- With no default and no rewrite that is a catalog change only, so the transaction is short; it
-- still waits for running queries on these tables to finish first. The index on the new column
-- is built in the next migration, in its own transaction, so these locks are not held while it
-- builds.
ALTER TABLE traces ADD COLUMN IF NOT EXISTS has_errors boolean;

-- Error occurrences (issue #22, D-93), derived at ingest so the error queries do not evaluate the
-- events JSON per row (src/storage/derive.ts, src/query/error-sql.ts): `is_occurrence` (status
-- error, and no exception event or one neither propagated nor expected) and `error_key` (a hash of
-- that exception's type, message and stack trace, for error spans). Nullable with no default: no
-- rewrite; rows stored before keep NULL and are read from their events JSON until they expire.
ALTER TABLE spans ADD COLUMN IF NOT EXISTS is_occurrence boolean;
ALTER TABLE spans ADD COLUMN IF NOT EXISTS error_key text;
