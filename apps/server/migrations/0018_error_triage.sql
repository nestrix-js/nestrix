-- Error triage (issue #26, D-103): the stored state of an error group (open, resolved, regressed,
-- ignored), the history regression detection needs, and the dedupe of "new error group" alerts.
--
-- None of these tables is partitioned or touched by span retention: a group's state outlives the
-- spans it was derived from. Rows are written by the error-group sync (src/errors/sync.ts), which
-- runs beside ingest rather than inside it, and by the admin triage routes.

-- Environments (issue #28, D-101, migration 0016): a group is stored per (service, environment,
-- group), so resolving a group in staging leaves the production copy open, and a regression in one
-- environment does not reopen another. `environment` here is `''` for the unset environment, not
-- NULL as on the span tables: it is part of the primary keys and of the foreign keys below, and a
-- NULL there would make the keys of unset groups distinct and skip their cascades. The ingest never
-- stores a blank environment (src/storage/derive.ts), so `''` cannot be a real name.

-- One row per (service, environment, group). The group key is the one `GET api/v1/errors/groups` returns
-- (`JSON.stringify([errorType, normalised message, route])`); `key_hash` is its SHA-256, so the
-- primary key stays small however long a route or exception type is.
CREATE TABLE error_groups (
  service_name text NOT NULL,
  environment text NOT NULL DEFAULT '',
  key_hash text NOT NULL,
  group_key text NOT NULL,
  error_type text,
  pattern text NOT NULL,
  route text,
  -- open: nothing decided; resolved: marked fixed; regressed: resolved, then seen again in a
  -- release other than the one it was resolved in (or any release when one is unknown);
  -- ignored: kept out of lists, counts and alerts until reopened.
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'regressed', 'ignored')),
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  first_release text,
  last_release text,
  -- Occurrences counted by the sync (best effort: see src/errors/sync.ts).
  occurrences bigint NOT NULL DEFAULT 0,
  resolved_at timestamptz,
  -- The release of the group's latest occurrence when it was resolved; NULL when unknown.
  resolved_in_release text,
  regressed_at timestamptz,
  -- When the server stored the group, and when it detected the latest regression: both on the
  -- database's clock, which is what an alert rule's `created_at` is on, so "after the rule was
  -- created" does not depend on the clocks of the applications that sent the spans.
  created_at timestamptz NOT NULL DEFAULT now(),
  regressed_detected_at timestamptz,
  -- How many times the group regressed: the "episode" of its regression alerts.
  regressions integer NOT NULL DEFAULT 0,
  ignored_at timestamptz,
  PRIMARY KEY (service_name, environment, key_hash)
);
-- The query API reads every group that is not open (the ignored set, the resolved ones).
CREATE INDEX error_groups_triaged_idx ON error_groups (state) WHERE state <> 'open';
-- New groups for the alert rule, and the retention of open groups.
CREATE INDEX error_groups_first_seen_idx ON error_groups (first_seen);
CREATE INDEX error_groups_last_seen_idx ON error_groups (last_seen);

-- Occurrences per release of a group.
CREATE TABLE error_group_releases (
  service_name text NOT NULL,
  environment text NOT NULL DEFAULT '',
  key_hash text NOT NULL,
  release text NOT NULL,
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  occurrences bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (service_name, environment, key_hash, release),
  FOREIGN KEY (service_name, environment, key_hash)
    REFERENCES error_groups (service_name, environment, key_hash) ON DELETE CASCADE
);

-- The sync's watermark (one row): spans starting at or before it were counted.
CREATE TABLE error_group_sync (
  id smallint PRIMARY KEY CHECK (id = 1),
  watermark timestamptz NOT NULL
);

-- One row per notification of a `new_error_group` rule. The primary key is the dedupe: episode 0
-- is the group's first appearance, episode N its Nth regression, so a notification is written at
-- most once per rule, group and episode, whichever server instance evaluates, and across restarts.
CREATE TABLE error_group_alerts (
  rule_id bigint NOT NULL REFERENCES alert_rules (id) ON DELETE CASCADE,
  service_name text NOT NULL,
  environment text NOT NULL DEFAULT '',
  key_hash text NOT NULL,
  episode integer NOT NULL,
  event_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, service_name, environment, key_hash, episode),
  FOREIGN KEY (service_name, environment, key_hash)
    REFERENCES error_groups (service_name, environment, key_hash) ON DELETE CASCADE
);

-- The new rule kind. It has no threshold, window or request minimum (stored as 0, 5 and 1, which
-- satisfy the existing checks), and its service is optional (NULL: every service). Its
-- `environment` (migration 0016) filters the groups like the other kinds' filters their data.
ALTER TABLE alert_rules ALTER COLUMN service_name DROP NOT NULL;
ALTER TABLE alert_rules DROP CONSTRAINT alert_rules_metric_check;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_metric_check
  CHECK (metric IN ('error_rate', 'p95_ms', 'slo_burn_rate', 'new_error_group'));
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_service_check
  CHECK (metric = 'new_error_group' OR service_name IS NOT NULL);
ALTER TABLE alert_rules DROP CONSTRAINT alert_rules_threshold_suits_metric;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_threshold_suits_metric CHECK (
  (metric = 'error_rate' AND threshold >= 0 AND threshold < 1)
  OR (metric = 'p95_ms' AND threshold > 0 AND threshold <= 3600000)
  OR (metric = 'slo_burn_rate' AND threshold > 0 AND threshold <= 1000)
  OR (metric = 'new_error_group' AND threshold = 0)
);
