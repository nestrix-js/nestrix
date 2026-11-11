-- The threshold must suit the metric (docs/backlog/phase-7.md, P7-03): the API checks it, and the
-- database enforces it too, so two concurrent PATCHes (one changing the metric, one the threshold)
-- cannot leave a rule such as `error_rate > 5`.
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_threshold_suits_metric CHECK (
  (metric = 'error_rate' AND threshold >= 0 AND threshold < 1)
  OR (metric = 'p95_ms' AND threshold > 0 AND threshold <= 3600000)
);
