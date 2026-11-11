/** Injection token of the `IngestSink` the receiver writes to (`model.ts`). */
export const INGEST_SINK = Symbol("nestrix-server:ingest-sink");

/** The OTLP/HTTP trace path. */
export const INGEST_TRACES_PATH = "/v1/traces";

/**
 * Every path Express routes to the receiver: its routing is case-insensitive and ignores a
 * trailing slash. Used for the self-tracing ignore list and to keep body parsers off ingest.
 */
export const INGEST_TRACES_PATH_PATTERN = /^\/v1\/traces\/?$/i;
