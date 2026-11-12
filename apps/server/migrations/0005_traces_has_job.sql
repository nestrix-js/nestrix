-- "Jobs" in the trace list means "traces that include job processing" (consumer span or
-- `nestrix.entry = 'job'`, any root), not "the root is a job": a request that enqueued a job
-- processed in the same trace has trace_type 'http' and has_job true. Set with OR semantics by
-- the per-trace upsert (src/storage/traces.ts). Existing rows keep false: they are not
-- backfilled (the flag is rebuilt only for traces that receive new spans).
ALTER TABLE traces ADD COLUMN has_job boolean NOT NULL DEFAULT false;
CREATE INDEX traces_has_job_seq_idx ON traces (seq DESC) WHERE has_job;
