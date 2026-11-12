-- Remote CPU profiling through the standalone server (docs/backlog/phase-10.md P10-02, D-76).
--
-- `instances`: app instances that opted in (`export.profiler: true`) and check in every 15 s on
-- POST /v1/nestrix/check-in. `principal` is the ingest key that first checked in for the instance
-- (`key:<n>`; `none` with ingest auth off); a later check-in with another key is refused, so a
-- different key cannot take over an instance's orders. Rows not seen for a day are deleted.
--
-- `remote_profiles`: one row per capture an admin started. `pending` until the instance's next
-- check-in hands it over (`running`, `principal` = the key that received the order), then `done`
-- (the profile, gzipped `.cpuprofile`), `failed` (reported by the instance) or `expired`
-- (pending over 60 s, or running over duration + 60 s). At most one pending or running capture per
-- instance (the partial unique index). Retention (src/profiler/store.ts): the newest 20 finished
-- per service, nothing older than the span retention.

CREATE TABLE instances (
  service text NOT NULL CHECK (char_length(service) BETWEEN 1 AND 256),
  instance_id text NOT NULL CHECK (char_length(instance_id) BETWEEN 1 AND 256),
  version text,
  host text,
  pid integer,
  runtime text,
  sdk_version text,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  principal text NOT NULL,
  PRIMARY KEY (service, instance_id)
);

CREATE INDEX instances_last_seen_idx ON instances (last_seen DESC);

CREATE TABLE remote_profiles (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{16}$'),
  service text NOT NULL,
  instance_id text NOT NULL,
  version text,
  state text NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed', 'expired')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 1000 AND 120000),
  actual_duration_ms double precision,
  samples integer,
  bytes integer,
  error text,
  profile bytea,                   -- the .cpuprofile, gzipped; set when state is done
  requested_by text NOT NULL,      -- who started it: 'admin' (the admin session)
  principal text                   -- the ingest key the order was handed to
);

-- One active capture per instance, enforced against concurrent starts.
CREATE UNIQUE INDEX remote_profiles_active_idx ON remote_profiles (service, instance_id)
  WHERE state IN ('pending', 'running');
CREATE INDEX remote_profiles_service_requested_idx ON remote_profiles (service, requested_at DESC);
CREATE INDEX remote_profiles_requested_idx ON remote_profiles (requested_at DESC);
