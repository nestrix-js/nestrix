-- Log lines kept next to their trace (docs/backlog/phase-9.md P9-07; D-19 as amended): OTLP log
-- records received on POST /v1/logs that carry a trace id. Context for the trace view, not a log
-- backend: no search index, at most 200 lines per trace (enforced by the writer,
-- src/storage/logs.ts), partitioned by UTC day of `time` and dropped with the spans by the same
-- retention (src/storage/partitions.ts creates and drops the partitions).
CREATE TABLE logs (
  trace_id text NOT NULL,
  span_id text,                    -- absent when the record names no span
  time timestamptz NOT NULL,       -- partition key; the same instant as time_ns
  time_ns bigint NOT NULL,         -- time_unix_nano, else observed_time_unix_nano
  severity_number integer NOT NULL CHECK (severity_number BETWEEN 0 AND 24),
  severity_text text NOT NULL,
  body text NOT NULL,              -- the body as text, cut to 8,192 characters
  context text,                    -- the nestrix.log.context attribute (Nest's logger context)
  service_name text NOT NULL,      -- service.name of the record's resource
  -- SHA-256 (hex) of the record's stored fields: a retried export does not store a line twice.
  record_hash text NOT NULL,
  PRIMARY KEY (trace_id, record_hash, time)
) PARTITION BY RANGE (time);

-- The trace view's read and the writer's per-trace count.
CREATE INDEX logs_trace_time_idx ON logs (trace_id, time_ns);
