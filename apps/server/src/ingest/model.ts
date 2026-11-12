/**
 * The receiver's output and the storage writer's input (phase 5, backlog P5-00).
 *
 * The receiver (P5-01) decodes OTLP/HTTP trace requests, protobuf or JSON, into these shapes;
 * the writer (P5-02) stores them. Ids are lowercase hex; times are Unix nanoseconds as bigint,
 * because OTLP's fixed64 does not fit a double. Attribute values follow OTLP's `AnyValue`, reduced
 * to what the query API can show: scalars, homogeneous scalar arrays, and anything else
 * (kvlists, bytes, mixed arrays) as its JSON text.
 */

export type IngestAttributeScalar = string | number | boolean;
export type IngestAttributeValue =
  | IngestAttributeScalar
  | readonly IngestAttributeScalar[];
export type IngestAttributes = Record<string, IngestAttributeValue>;

/** OTLP `Span.SpanKind` mapped to the query API's names; `unspecified` becomes `internal`. */
export type IngestSpanKind =
  | "server"
  | "client"
  | "internal"
  | "producer"
  | "consumer";

export interface IngestEvent {
  name: string;
  timeUnixNano: bigint;
  attributes: IngestAttributes;
}

export interface IngestLink {
  traceId: string;
  spanId: string;
  attributes: IngestAttributes;
}

export interface IngestSpan {
  traceId: string;
  spanId: string;
  /** Absent for a root. */
  parentSpanId?: string;
  name: string;
  kind: IngestSpanKind;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: IngestAttributes;
  events: IngestEvent[];
  links: IngestLink[];
  status: { code: "unset" | "ok" | "error"; message?: string };
  /** Instrumentation scope name. */
  scope?: string;
}

/** One OTLP `ResourceSpans`: the resource once, its spans flattened across scopes. */
export interface IngestResourceSpans {
  resource: IngestAttributes;
  spans: IngestSpan[];
}

/** One decoded export request. `rejectedSpans` counts spans the receiver dropped as invalid (partial success). */
export interface IngestBatch {
  resourceSpans: IngestResourceSpans[];
  rejectedSpans: number;
  /** Why spans were rejected, for OTLP's `partial_success.error_message`. */
  errorMessage?: string;
}

/**
 * One OTLP log record that carries a trace id (P9-07): logs are kept as context for a trace, so a
 * record without one is not kept. Strings are capped and made safe for PostgreSQL by the mapper.
 */
export interface IngestLogRecord {
  traceId: string;
  /** Absent when the record names no span. */
  spanId?: string;
  /** `time_unix_nano`, else `observed_time_unix_nano`. */
  timeUnixNano: bigint;
  /** OTLP `SeverityNumber`, 0 to 24 (anything else becomes 0). */
  severityNumber: number;
  severityText: string;
  /** The body as text (a non-string body is its JSON text), cut to `MAX_LOG_BODY_LENGTH`. */
  body: string;
  /** The `nestrix.log.context` attribute (Nest's logger context), when it is a string. */
  context?: string;
}

/** One OTLP `ResourceLogs`: the resource once, its kept records flattened across scopes. */
export interface IngestResourceLogs {
  resource: IngestAttributes;
  records: IngestLogRecord[];
}

/** One decoded log export request. */
export interface IngestLogBatch {
  resourceLogs: IngestResourceLogs[];
  /** Records rejected as invalid (partial success). Records without a trace id are not rejected. */
  rejectedLogRecords: number;
  errorMessage?: string;
}

/** What the receiver hands a batch to. Implemented by the storage writer (P5-02). */
export interface IngestSink {
  /**
   * Stores a batch. Resolves when it is durable. Rejects with `IngestBusyError` when the writer
   * is over capacity (the receiver answers 503 with `Retry-After`).
   */
  write(batch: IngestBatch): Promise<void>;
  /**
   * Stores log records next to their traces (P9-07), with the same contract as `write`. A sink
   * without it accepts log exports and keeps nothing.
   */
  writeLogs?(batch: IngestLogBatch): Promise<void>;
}

export class IngestBusyError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("ingest is over capacity");
    this.name = "IngestBusyError";
  }
}
