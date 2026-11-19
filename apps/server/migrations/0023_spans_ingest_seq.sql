-- Ingest order on `spans` (D-114): `ingest_seq`, taken from a sequence when a row is inserted, so
-- the error-group sync and the live `GET errors` cursor follow the order spans were stored in, not
-- their start time. Before this, a span stored after the readers had passed its start (a job that
-- ends minutes after it started, a late export, a slow clock) was never counted by the sync and
-- never shown by a live poll (D-103 (2), D-107 (9)).
--
-- * Added nullable with no default, then given the default in a second statement. Rows stored
--   before this migration keep NULL: the readers treat NULL as older than every sequenced row
--   (D-114). `ADD COLUMN ... DEFAULT nextval(...)` in one statement would rewrite every partition
--   (a volatile default is computed per existing row); measured on PostgreSQL 18.6, 1,000,000 rows
--   in two partitions: the two-step form left both partitions' relfilenode unchanged and took
--   0.4 ms + 0.8 ms, the one-step form rewrote both (new relfilenodes) in 1.4 s.
-- * `SET DEFAULT` on the partitioned parent recurses to every partition, and partitions created
--   later (`CREATE TABLE ... PARTITION OF spans`) inherit it. A writer that does not name the
--   column, which is every writer so far (0.7.0, 0.8.0 and this release), gets a value: nothing in
--   the INSERT statements changes, so a previous release keeps working during a rolling upgrade.
-- * Ordering: the value is taken while the INSERT runs, and every span-writing transaction holds
--   the `TRACES_LOCK` advisory transaction lock from before its INSERT until it commits
--   (src/storage/writer.ts, applyTraceCap). So values are handed out and committed in the same
--   order, and a reader that sees value N sees every committed value below it: a cursor on
--   `ingest_seq` never skips a row that commits later. A rolled-back or conflicting insert leaves
--   a gap, which a reader cannot tell from a skipped row and does not need to.
-- * `CACHE 1` (the default, stated because it matters): with a larger cache each session would
--   pre-allocate a block of values and hand them out out of order.
--
-- `error_group_sync` gains the state of the sync's switch to ingest order (src/errors/sync.ts):
-- `seq_watermark` (the ingest-order watermark, NULL until the first run of this release),
-- `legacy_seq` (rows at or below it, or NULL, were stored before the switch and are read by start
-- time as before), `legacy_watermark` and `legacy_until` (that start-time read's watermark and its
-- end). `watermark` is the previous release's; this release parks it ahead of the clock so a
-- previous-release replica still running during a rolling upgrade counts nothing twice.
--
-- Locks: each ALTER TABLE takes an ACCESS EXCLUSIVE lock on `spans` and every partition (seen in
-- pg_locks), held until this file's transaction commits. Both are catalog changes only, so the
-- transaction commits at once; it waits for queries and ingest transactions already running on
-- `spans`, and new ones queue behind it for that moment. The index on the column is built in
-- 0024_spans_ingest_seq_index.sql, a separate transaction, so this lock is not held while it builds.
CREATE SEQUENCE IF NOT EXISTS spans_ingest_seq AS bigint CACHE 1;
ALTER TABLE spans ADD COLUMN IF NOT EXISTS ingest_seq bigint;
ALTER TABLE spans ALTER COLUMN ingest_seq SET DEFAULT nextval('spans_ingest_seq');

ALTER TABLE error_group_sync
  ADD COLUMN IF NOT EXISTS seq_watermark bigint,
  ADD COLUMN IF NOT EXISTS legacy_seq bigint,
  ADD COLUMN IF NOT EXISTS legacy_watermark timestamptz,
  ADD COLUMN IF NOT EXISTS legacy_until timestamptz;
