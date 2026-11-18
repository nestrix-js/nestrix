-- Environments (issue #28, D-101): `deployment.environment.name` of the resource (falling back to
-- `deployment.environment`), or the environment an ingest key is bound to, which overrides what
-- the resource claims (src/ingest/receiver.ts). Stored next to every `service_name` the queries
-- group or filter by, so two apps with the same service name in different environments are kept
-- apart. NULL is "unset" (no environment); every row stored before this migration is unset.
--
-- Columns: nullable with no default, so adding them rewrites nothing (a catalog change).
--
-- Locks: everything below runs in one transaction (src/storage/migrate.ts runs one per file), so
-- every lock is held until it commits. Each ADD COLUMN takes an ACCESS EXCLUSIVE lock on its table
-- and partitions: queries and ingest on these tables wait for the transaction. The columns
-- themselves are instant; what takes time is building the two rollup keys below, which reads
-- `route_minutes` and `class_minutes` once (one row per minute, service, route or method: far
-- smaller than `spans`). `spans` and `traces` get no index. A large install can build the keys
-- first without blocking anything (apps/server/README.md, upgrade notes); the IF NOT EXISTS
-- statements then do nothing.
ALTER TABLE spans ADD COLUMN IF NOT EXISTS environment text;
ALTER TABLE traces ADD COLUMN IF NOT EXISTS environment text;
ALTER TABLE route_minutes ADD COLUMN IF NOT EXISTS environment text;
ALTER TABLE class_minutes ADD COLUMN IF NOT EXISTS environment text;
ALTER TABLE logs ADD COLUMN IF NOT EXISTS environment text;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS environment text;
-- The environment scope of an alert rule and of an SLO: NULL watches every environment (the
-- behaviour before this migration), `unset` the rows without one, any other value that one.
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS environment text;
ALTER TABLE slos ADD COLUMN IF NOT EXISTS environment text;

-- The rollups are summed per environment: their key gains `environment`. NULLS NOT DISTINCT makes
-- the unset environment one key (PostgreSQL 15 and later), so the writer's ON CONFLICT on these
-- columns merges unset rows as the primary key did. The primary key (without the environment) is
-- dropped after the new key exists; it would otherwise merge two environments' minutes.
CREATE UNIQUE INDEX IF NOT EXISTS route_minutes_env_key
  ON route_minutes (minute, service_name, environment, method, route) NULLS NOT DISTINCT;
ALTER TABLE route_minutes DROP CONSTRAINT IF EXISTS route_minutes_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS class_minutes_env_key
  ON class_minutes (minute, service_name, environment, class_name, method_name) NULLS NOT DISTINCT;
ALTER TABLE class_minutes DROP CONSTRAINT IF EXISTS class_minutes_pkey;

-- (service, environment) pairs seen, with the last time a batch carried them (refreshed at most
-- once a minute per pair by the writer, like `services`). Answers `MetaResponse.environments`
-- and the map's service nodes of one environment without a scan. Seeded from `services` as unset,
-- which is what every stored row is.
CREATE TABLE IF NOT EXISTS service_environments (
  service_name text NOT NULL,
  environment text,
  last_seen timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS service_environments_key
  ON service_environments (service_name, environment) NULLS NOT DISTINCT;
INSERT INTO service_environments (service_name, environment, last_seen)
  SELECT name, NULL, last_seen FROM services
  ON CONFLICT (service_name, environment) DO NOTHING;
