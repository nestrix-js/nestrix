/** Injection token of the `IngestSink` the receiver writes to (`model.ts`). */
export const INGEST_SINK = Symbol("nestrix-server:ingest-sink");

/** The OTLP/HTTP trace path. */
export const INGEST_TRACES_PATH = "/v1/traces";

/** The OTLP/HTTP log path (P9-07): records with a trace id are kept next to their trace. */
export const INGEST_LOGS_PATH = "/v1/logs";

/**
 * The OTLP/HTTP metrics path (issue #18, D-105). Routed to the receiver only with
 * `NESTRIX_METRICS=on`; otherwise the unknown-path middleware answers it `404` first (D-82 (7)).
 */
export const INGEST_METRICS_PATH = "/v1/metrics";

/** `INGEST_METRICS_PATH` as Express routes it (case-insensitive, optional trailing slash). */
export const INGEST_METRICS_PATH_PATTERN = /^\/v1\/metrics\/?$/i;

/** Remote profiling, instance side (P10-02, D-76): the check-in. */
export const CHECK_IN_PATH = "/v1/nestrix/check-in";
/** Remote profiling, instance side: the upload of a capture (`:id`) and its failure report. */
export const PROFILE_UPLOAD_PATH = "/v1/nestrix/profiles/:id";
export const PROFILE_FAILED_PATH = "/v1/nestrix/profiles/:id/failed";

/**
 * Every path Express routes to an ingest-key route: the receiver (traces, logs, and metrics when
 * they are on: with them off the unknown-path middleware answers `/v1/metrics` first) and the
 * instance side of remote profiling (check-in, profile upload, failure report). Express's routing
 * is case-insensitive, ignores a trailing slash and matches `:id` as one raw segment, so the
 * pattern does the same. Used for the admin login's exemption (these routes authenticate with an
 * ingest key instead), the self-tracing ignore list and to keep body parsers off ingest.
 */
export const INGEST_PATH_PATTERN =
  /^\/v1\/(?:traces|logs|metrics|nestrix\/check-in|nestrix\/profiles\/[^/]+(?:\/failed)?)\/?$/i;

/** The `google.rpc.Status` message of an OTLP path this server does not ingest (`unknown-path.ts`). */
export const UNKNOWN_OTLP_PATH_MESSAGE =
  "not found: this server ingests OTLP traces (POST /v1/traces) and logs (POST /v1/logs) only; send metrics to an OpenTelemetry Collector";
