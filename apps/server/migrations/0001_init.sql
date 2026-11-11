-- Nestrix standalone server: initial schema (backlog P5-02).
--
-- Applied by src/storage/migrate.ts, in file-name order, once each, inside a transaction,
-- under a Postgres advisory lock. A file is never edited after it ships: the runner stores
-- its SHA-256 and refuses to start when an applied file has changed. Changes go in a new file.
--
-- Time-ordered tables (spans, traces, route_minutes, class_minutes) are partitioned by
-- UTC day on a timestamptz column. Their partitions are created by src/storage/partitions.ts
-- (today and the next two days at start, then hourly) and dropped by retention; this file
-- creates only the partitioned parents. There is no DEFAULT partition: a row for a day
-- without a partition is filtered out by the writer before it reaches the database.
--
-- Times: `*_ns` columns are Unix nanoseconds as bigint (OTLP's fixed64; values above
-- int8's range are outside every partition and never inserted). `start_time` and friends
-- are the same instant as timestamptz (microsecond precision) and are the partition keys.

-- Hash-deduplicated resource attributes. Not partitioned and not removed by retention:
-- there is one row per distinct resource (service instance), not per span.
CREATE TABLE resources (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- SHA-256 (hex) of the canonical JSON of `attributes` (keys sorted).
  hash text NOT NULL UNIQUE,
  service_name text NOT NULL,
  service_version text,
  attributes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Service names seen, with the last time a batch carried them (refreshed at most once a
-- minute per service by the writer). Answers `MetaResponse.services` without a scan.
CREATE TABLE services (
  name text PRIMARY KEY,
  last_seen timestamptz NOT NULL
);

-- Every stored span.
CREATE TABLE spans (
  trace_id text NOT NULL,
  span_id text NOT NULL,
  parent_span_id text,
  resource_id bigint NOT NULL,
  service_name text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('server', 'client', 'internal', 'producer', 'consumer')),
  start_time timestamptz NOT NULL,
  start_ns bigint NOT NULL,
  end_ns bigint NOT NULL,
  duration_ns bigint NOT NULL,
  status_code text NOT NULL CHECK (status_code IN ('unset', 'ok', 'error')),
  status_message text,
  scope text,
  -- Attribute values as the receiver decoded them (scalars and scalar arrays).
  attributes jsonb NOT NULL,
  -- [{ "name", "timeUnixNano" (string), "attributes" }]
  events jsonb NOT NULL,
  -- [{ "traceId", "spanId", "attributes" }]
  links jsonb NOT NULL,
  -- Extracted from attributes at ingest (src/storage/derive.ts):
  http_route text,               -- http.route
  http_method text,              -- http.request.method
  http_status integer,           -- http.response.status_code
  is_root boolean NOT NULL,      -- no parent span id
  is_error boolean NOT NULL,     -- status code error (the embedded store's error definition)
  trace_type text NOT NULL CHECK (trace_type IN ('http', 'job', 'scheduled', 'other')),
  user_id text,                  -- user.id
  class_name text,               -- nestrix.class (level 2 method spans)
  method_name text,              -- nestrix.method
  PRIMARY KEY (trace_id, span_id, start_time)
) PARTITION BY RANGE (start_time);

-- Window scans (map, own time, services in a window).
CREATE INDEX spans_start_time_idx ON spans (start_time);
-- Errors list, newest first.
CREATE INDEX spans_errors_idx ON spans (start_time DESC, trace_id, span_id) WHERE is_error;
-- Method spans in a window (class own time).
CREATE INDEX spans_methods_idx ON spans (start_time) WHERE class_name IS NOT NULL;

-- One summary row per trace, upserted by the writer as the trace's spans arrive
-- (src/storage/traces.ts has the root rule). Partitioned by `partition_time`: the start
-- time of the earliest span in the batch that created the row, never updated, so a
-- trace's row stays in one partition. `start_time` is the root's and may move earlier.
CREATE TABLE traces (
  trace_id text NOT NULL,
  partition_time timestamptz NOT NULL,
  -- Creation order, from a sequence: the stable cursor for "newest first" lists.
  seq bigint NOT NULL,
  root_span_id text NOT NULL,
  root_parent_span_id text,
  resource_id bigint NOT NULL,
  service_name text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  start_time timestamptz NOT NULL,
  start_ns bigint NOT NULL,
  duration_ns bigint NOT NULL,
  http_method text,
  http_route text,
  http_status integer,
  is_error boolean NOT NULL,
  trace_type text NOT NULL,
  release text,
  user_id text,
  span_count integer NOT NULL,
  error_count integer NOT NULL,
  -- Distinct service names of the trace's spans.
  services text[] NOT NULL,
  -- Distinct span names (at most 64, each at most 256 characters), for `search`.
  span_names text[] NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trace_id, partition_time)
) PARTITION BY RANGE (partition_time);

CREATE SEQUENCE traces_seq AS bigint CACHE 100;
CREATE INDEX traces_seq_idx ON traces (seq DESC);
CREATE INDEX traces_service_seq_idx ON traces (service_name, seq DESC);
CREATE INDEX traces_errors_seq_idx ON traces (seq DESC) WHERE is_error;
CREATE INDEX traces_route_seq_idx ON traces (http_route, seq DESC) WHERE http_route IS NOT NULL;
CREATE INDEX traces_start_time_idx ON traces (start_time);
CREATE INDEX traces_services_idx ON traces USING gin (services);

-- Element-wise sum of two histograms of equal length (the rollups' latency buckets).
CREATE FUNCTION nestrix_hist_add(a integer[], b integer[]) RETURNS integer[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN ARRAY(
    SELECT coalesce(x, 0) + coalesce(y, 0)
    FROM unnest(a, b) WITH ORDINALITY AS t(x, y, i)
    ORDER BY i
  );

-- Per minute (of the span's end), service, method and route: HTTP server spans
-- (kind server with http.request.method). `hist` has 30 buckets; bounds in
-- src/storage/histogram.ts (the same as the embedded route statistics).
CREATE TABLE route_minutes (
  minute timestamptz NOT NULL,
  service_name text NOT NULL,
  method text NOT NULL,
  route text NOT NULL,
  count integer NOT NULL,
  errors integer NOT NULL,
  total_ms double precision NOT NULL,
  max_ms double precision NOT NULL,
  hist integer[] NOT NULL,
  PRIMARY KEY (minute, service_name, method, route)
) PARTITION BY RANGE (minute);

CREATE INDEX route_minutes_service_idx ON route_minutes (service_name, minute);

-- Per minute, service, class and method: level 2 method spans (nestrix.class and
-- nestrix.method). Counted after sampling, unlike the embedded class statistics.
CREATE TABLE class_minutes (
  minute timestamptz NOT NULL,
  service_name text NOT NULL,
  class_name text NOT NULL,
  method_name text NOT NULL,
  -- nestrix.component (a ClassKind); 'provider' when absent.
  class_kind text NOT NULL,
  count integer NOT NULL,
  errors integer NOT NULL,
  total_ms double precision NOT NULL,
  max_ms double precision NOT NULL,
  hist integer[] NOT NULL,
  PRIMARY KEY (minute, service_name, class_name, method_name)
) PARTITION BY RANGE (minute);

CREATE INDEX class_minutes_service_idx ON class_minutes (service_name, minute);
