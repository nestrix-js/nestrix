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
  /** 32 hex characters, or `""` for a record without a trace (`NESTRIX_LOGS=all` only). */
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
  /** The body was longer than `MAX_LOG_BODY_LENGTH` and was cut (D-106). */
  truncated?: boolean;
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

/**
 * One stored metric data point (issue #18, D-105), after the mapper applied the catalog
 * (`metrics/catalog.ts`): the attribute set is reduced to the catalog's keys and points that
 * collapsed into one are already merged. Times are Unix nanoseconds.
 */
export interface IngestMetricPoint {
  /** The catalog name. */
  metric: string;
  kind: "counter" | "gauge" | "histogram";
  temporality: "cumulative" | "delta";
  /** Kept attributes (null-prototype object), and their canonical JSON (sorted keys). */
  attributes: Record<string, string>;
  attributesKey: string;
  timeUnixNano: bigint;
  /** `start_time_unix_nano`; 0 when the sender gave none (cumulative only). */
  startTimeUnixNano: bigint;
  /** Gauge: the value. Counter: the cumulative value, or the delta. Histogram: unused (0). */
  value: number;
  /** Histogram only. */
  count?: number;
  /** Histogram only; `null` when the point carries no sum. */
  sum?: number | null;
  bounds?: number[];
  bucketCounts?: number[];
}

/** One OTLP `ResourceMetrics`: who sent it, and its stored points. */
export interface IngestResourceMetrics {
  serviceName: string;
  /**
   * `deployment.environment.name` of the resource (`environmentOf`), or the bound ingest key's
   * environment (issue #28, D-101); `null` is no environment.
   */
  environment: string | null;
  /** `service.instance.id`, `""` when the resource has none. */
  instanceId: string;
  points: IngestMetricPoint[];
}

/** What a metric export carried that is not stored, by reason (data points). */
export interface MetricDropCounts {
  /** ExponentialHistogram, Summary, a non-monotonic delta Sum, or a metric with no data. */
  unsupportedType: number;
  /** Metric names outside the catalog. */
  notStored: number;
  /** A catalog name with another instrument type or unit than the catalog's. */
  typeMismatch: number;
  /** Points flagged "no recorded value" (staleness markers). */
  noRecordedValue: number;
}

/** One decoded metric export request (issue #18). */
export interface IngestMetricBatch {
  resourceMetrics: IngestResourceMetrics[];
  /** Points rejected as invalid (OTLP partial success). */
  rejectedDataPoints: number;
  errorMessage?: string;
  dropped: MetricDropCounts;
}

/** What a sink reports about a stored metric batch. */
export interface IngestMetricWriteResult {
  /** Points of series over the per-service or total series cap. */
  overSeriesCap: number;
  /** Points older than retention or more than two days ahead. */
  outOfRange: number;
}

/** What a sink reports about a stored batch. */
export interface IngestWriteResult {
  /** Spans not stored because their trace is over the per-trace cap (D-78); reported as partial success. */
  droppedSpans?: number;
}

/** What the receiver hands a batch to. Implemented by the storage writer (P5-02). */
export interface IngestSink {
  /**
   * Stores a batch. Resolves when it is durable. Rejects with `IngestBusyError` when the writer
   * is over capacity (the receiver answers 503 with `Retry-After`). May answer with the spans it
   * did not store because of a per-trace cap.
   */
  write(batch: IngestBatch): Promise<void | IngestWriteResult>;
  /**
   * Stores log records next to their traces (P9-07), with the same contract as `write`. A sink
   * without it accepts log exports and keeps nothing.
   */
  writeLogs?(batch: IngestLogBatch): Promise<void>;
  /**
   * Stores metric points (issue #18, D-105), with the same contract as `write`. Called only when
   * `NESTRIX_METRICS=on`; a sink without it accepts metric exports and keeps nothing.
   */
  writeMetrics?(
    batch: IngestMetricBatch,
  ): Promise<IngestMetricWriteResult | undefined>;
}

export class IngestBusyError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("ingest is over capacity");
    this.name = "IngestBusyError";
  }
}
