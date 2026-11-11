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

/** What the receiver hands a batch to. Implemented by the storage writer (P5-02). */
export interface IngestSink {
  /**
   * Stores a batch. Resolves when it is durable. Rejects with `IngestBusyError` when the writer
   * is over capacity (the receiver answers 503 with `Retry-After`).
   */
  write(batch: IngestBatch): Promise<void>;
}

export class IngestBusyError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("ingest is over capacity");
    this.name = "IngestBusyError";
  }
}
