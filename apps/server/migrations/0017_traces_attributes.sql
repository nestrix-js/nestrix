-- Attribute filters and request-id search (issue #27, D-102).
--
-- `indexed_attributes`: per trace, the values of the attribute keys listed in
-- NESTRIX_INDEXED_ATTRIBUTES, as text (`{"tenant.id": "acme"}`); the query API's `attr.<key>=`
-- filters compare them with `@>`. Filled at ingest only for the keys listed then: a key added
-- later is not backfilled, and a key removed stays in rows already stored until they expire.
-- `request_ids`: the distinct recorded `x-request-id` request and response header values of the
-- trace's spans, so the trace list's `search` finds the trace a customer quotes. Both are written
-- by the per-trace upsert (src/storage/traces.ts); see src/storage/derive.ts for the rules.
--
-- Nullable with no default, so adding them rewrites nothing; existing rows keep NULL and match no
-- attribute filter or request id.
--
-- Locks: ADD COLUMN takes an ACCESS EXCLUSIVE lock on `traces` and its partitions, and the two
-- GIN indexes then build in the same transaction (src/storage/migrate.ts runs one per file), so
-- the trace upsert and the trace list wait until both are built. Every existing row is NULL in
-- both columns and the indexes are partial (`IS NOT NULL`), so the build is a scan of `traces`
-- (one row per trace, not per span) that adds no entries. A large install can pre-create the
-- columns and indexes per partition as apps/server/README.md describes for migration 0013; every
-- statement here is IF NOT EXISTS.
ALTER TABLE traces ADD COLUMN IF NOT EXISTS indexed_attributes jsonb;
ALTER TABLE traces ADD COLUMN IF NOT EXISTS request_ids text[];
CREATE INDEX IF NOT EXISTS traces_indexed_attributes_idx ON traces
  USING gin (indexed_attributes jsonb_path_ops) WHERE indexed_attributes IS NOT NULL;
CREATE INDEX IF NOT EXISTS traces_request_ids_idx ON traces
  USING gin (request_ids) WHERE request_ids IS NOT NULL;
