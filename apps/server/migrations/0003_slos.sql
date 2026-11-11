-- SLOs over the route rollups (docs/backlog/phase-7.md, P7-04), and burn-rate alert rules.

CREATE TABLE slos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  service_name text NOT NULL CHECK (char_length(service_name) BETWEEN 1 AND 256),
  -- NULL: every route of the service. Otherwise `route_minutes.route`, any method.
  route text CHECK (route IS NULL OR char_length(route) BETWEEN 1 AND 512),
  -- availability: share of requests that are not errors (status error or 5xx, the rollup's definition).
  -- latency: share of requests faster than latency_threshold_ms (estimated from the histogram).
  kind text NOT NULL CHECK (kind IN ('availability', 'latency')),
  latency_threshold_ms double precision
    CHECK (latency_threshold_ms IS NULL OR (latency_threshold_ms > 0 AND latency_threshold_ms <= 3600000)),
  -- The target share of good requests, e.g. 0.999.
  objective double precision NOT NULL CHECK (objective > 0 AND objective < 1),
  window_days integer NOT NULL CHECK (window_days IN (7, 30)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'latency') = (latency_threshold_ms IS NOT NULL))
);

-- A burn-rate rule references its SLO; the rule's window is the burn-rate window.
ALTER TABLE alert_rules ADD COLUMN slo_id bigint REFERENCES slos (id) ON DELETE CASCADE;
ALTER TABLE alert_rules DROP CONSTRAINT alert_rules_metric_check;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_metric_check
  CHECK (metric IN ('error_rate', 'p95_ms', 'slo_burn_rate'));
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_slo_check
  CHECK ((metric = 'slo_burn_rate') = (slo_id IS NOT NULL));
