-- Spans of a trace that the server did not store because the trace was over
-- NESTRIX_MAX_SPANS_PER_TRACE (D-78). Added by the ingest writer in the transaction that drops
-- them (src/storage/writer.ts); the `trace` query reports it as `droppedSpans.byServer`.
-- Existing rows keep 0.
ALTER TABLE traces ADD COLUMN dropped_spans bigint NOT NULL DEFAULT 0;
