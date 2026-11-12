/** Injection token of the `IngestSink` the receiver writes to (`model.ts`). */
export const INGEST_SINK = Symbol("nestrix-server:ingest-sink");

/** The OTLP/HTTP trace path. */
export const INGEST_TRACES_PATH = "/v1/traces";

/** The OTLP/HTTP log path (P9-07): records with a trace id are kept next to their trace. */
export const INGEST_LOGS_PATH = "/v1/logs";

/** Remote profiling, instance side (P10-02, D-76): the check-in. */
export const CHECK_IN_PATH = "/v1/nestrix/check-in";
/** Remote profiling, instance side: the upload of a capture (`:id`) and its failure report. */
export const PROFILE_UPLOAD_PATH = "/v1/nestrix/profiles/:id";
export const PROFILE_FAILED_PATH = "/v1/nestrix/profiles/:id/failed";

/**
 * Every path Express routes to an ingest-key route: the receiver (traces, logs) and the
 * instance side of remote profiling (check-in, profile upload, failure report). Express's routing
 * is case-insensitive, ignores a trailing slash and matches `:id` as one raw segment, so the
 * pattern does the same. Used for the admin login's exemption (these routes authenticate with an
 * ingest key instead), the self-tracing ignore list and to keep body parsers off ingest.
 */
export const INGEST_PATH_PATTERN =
  /^\/v1\/(?:traces|logs|nestrix\/check-in|nestrix\/profiles\/[^/]+(?:\/failed)?)\/?$/i;
