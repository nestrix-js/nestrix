/** Injection token of the `IngestSink` the receiver writes to (`model.ts`). */
export const INGEST_SINK = Symbol("nestrix-server:ingest-sink");

/** The OTLP/HTTP trace path. */
export const INGEST_TRACES_PATH = "/v1/traces";

/** The OTLP/HTTP log path (P9-07): records with a trace id are kept next to their trace. */
export const INGEST_LOGS_PATH = "/v1/logs";

/**
 * Every path Express routes to the receiver, traces and logs: its routing is case-insensitive and
 * ignores a trailing slash. Used for the admin login's exemption (the receiver authenticates with
 * an ingest key instead), the self-tracing ignore list and to keep body parsers off ingest.
 */
export const INGEST_PATH_PATTERN = /^\/v1\/(?:traces|logs)\/?$/i;
