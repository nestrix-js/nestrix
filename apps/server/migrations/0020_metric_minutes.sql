-- Optional metrics (issue #18, D-105): the runtime metrics Nestrix emits, received on POST /v1/metrics
-- when NESTRIX_METRICS=on, aggregated per minute on write (src/storage/metrics.ts). Only the metrics
-- in src/metrics/catalog.ts are stored. Partitioned by UTC day of `minute` and dropped with the spans
-- by the same retention (src/storage/partitions.ts). With metrics off the table and its day partitions
-- exist and stay empty.
--
-- One row per series and minute. A series is (service, instance, metric, series_key); series_key is a
-- SHA-256 of the kept attributes, the temporality and, for a histogram, its bucket bounds, so a row
-- holds one kind of data:
--   gauge (a Gauge or a non-monotonic cumulative Sum): sum_value/count_value/min_value/max_value over
--     the minute's points, last_value at time_ns;
--   counter, cumulative: last_value is the newest cumulative value, start_ns its start time (the query
--     takes differences between consecutive rows; a changed start or a lower value is a reset);
--   counter, delta: sum_value is the sum of the minute's deltas;
--   histogram: bounds and buckets (the newest cumulative counts, or the summed deltas), hist_count and
--     hist_sum the same way.
-- `environment` (issue #28, D-101) is the resource's `deployment.environment.name` or the bound ingest
-- key's environment, NULL when unset, as on route_minutes; it is part of the row key (NULLS NOT DISTINCT).
CREATE TABLE metric_minutes (
  minute timestamptz NOT NULL,         -- partition key: the minute (UTC) of the points' time
  service_name text NOT NULL,
  environment text,                    -- NULL: no environment (D-101)
  instance_id text NOT NULL,           -- service.instance.id, '' when the resource has none
  metric_name text NOT NULL,
  series_key text NOT NULL,
  attributes jsonb NOT NULL,           -- the kept attributes (catalog keys only)
  kind text NOT NULL CHECK (kind IN ('gauge', 'counter', 'histogram')),
  temporality text NOT NULL CHECK (temporality IN ('cumulative', 'delta')),
  time_ns bigint NOT NULL,             -- time of the newest point in the minute
  start_ns bigint NOT NULL,            -- its start time (0 when the sender gave none)
  last_value double precision,
  sum_value double precision,
  count_value bigint,
  min_value double precision,
  max_value double precision,
  bounds double precision[],
  buckets double precision[],
  hist_count double precision,
  hist_sum double precision
) PARTITION BY RANGE (minute);

-- The row key. A unique index rather than a primary key, so `environment` can be NULL (PostgreSQL 15+).
CREATE UNIQUE INDEX metric_minutes_key
  ON metric_minutes (service_name, environment, metric_name, instance_id, series_key, minute)
  NULLS NOT DISTINCT;

-- The series query without an instance: every instance of a service's metric over a time range.
CREATE INDEX metric_minutes_metric_idx ON metric_minutes (metric_name, minute);
