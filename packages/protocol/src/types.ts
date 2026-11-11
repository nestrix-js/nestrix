/** Response types of the Nestrix query API, version 1. Types only; no runtime code lives here except the version constant (see index.ts). */

export type AttributeScalar = string | number | boolean;
/** An OpenTelemetry attribute value: a scalar or a homogeneous array of scalars. */
export type AttributeValue = AttributeScalar | readonly AttributeScalar[];
export type Attributes = Record<string, AttributeValue>;

export type SpanKind =
  | "server"
  | "client"
  | "internal"
  | "producer"
  | "consumer";
export type StatusCode = "unset" | "ok" | "error";

export interface SpanEvent {
  name: string;
  timeUnixMs: number;
  attributes: Attributes;
}

export interface SpanLink {
  traceId: string;
  spanId: string;
}

/** One stored span, copied from the SDK span after scrubbing and the user's `redact` hook. Times are fractional milliseconds. */
export interface SpanRecord {
  spanId: string;
  /** Absent for a trace root. Present but not among the trace's spans when the parent is remote; such a span is still the local root. */
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTimeUnixMs: number;
  durationMs: number;
  attributes: Attributes;
  events: SpanEvent[];
  status: { code: StatusCode; message?: string };
  links: SpanLink[];
  /** Instrumentation scope name. */
  scope?: string;
}

/** Why a response is not the whole answer; shown by the UI as a banner. */
export interface ApiWarning {
  code: string;
  message: string;
}

/** `GET api/v1/meta` */
export interface MetaResponse {
  protocolVersion: number;
  /** Identifies this process; a cursor from another process answers `reset: true`. */
  processId: string;
  serverTimeUnixMs: number;
  service: {
    name?: string;
    version?: string;
    environment?: string;
  };
  /** `rate` is `null` when the host owns the sampler and Nestrix cannot know it. */
  sampling: { owner: "nestrix"; rate: number } | { owner: "host"; rate: null };
  store: {
    traces: number;
    spans: number;
    bytes: number;
    maxTraces: number;
    maxBytes: number;
    /** Traces evicted to stay within the limits since the process started. */
    evictedTraces: number;
    /** Spans or attribute data dropped by the redaction step or size limits since the process started. */
    droppedSpans: number;
  };
  statistics: {
    /** Unix ms from which route statistics have been counted (process start). */
    sinceUnixMs: number;
    /** Windows the routes endpoint accepts. */
    windowsMinutes: number[];
  };
  warnings: ApiWarning[];
}

/** Fields shared by every cursor-paged list response. */
export interface PagedResponse {
  /** Cursor of the newest item in the store, to pass as `after` on the next poll; `null` when the store is empty. */
  head: string | null;
  /** Cursor for "load older" (pass as `before`); `null` at the end of the store. */
  older: string | null;
  /** True when the request's cursor came from another process or was evicted; `items` then start from the newest. */
  reset: boolean;
}

export interface TraceSummary {
  traceId: string;
  /** The local root: the earliest span with no parent inside the trace (a remote parent counts as none). */
  rootSpanId: string;
  name: string;
  method?: string;
  route?: string;
  statusCode?: number;
  /** True under the error definition (5xx, thrown handler, exception event or error status on the root). */
  error: boolean;
  startTimeUnixMs: number;
  durationMs: number;
  spanCount: number;
  /** Opaque paging cursor of this item. */
  cursor: string;
}

/** `GET api/v1/traces` */
export interface TraceListResponse extends PagedResponse {
  items: TraceSummary[];
}

/** `GET api/v1/trace?id=` */
export interface TraceResponse {
  traceId: string;
  rootSpanId: string;
  /** Resource attributes, once for the whole trace. */
  resource: Attributes;
  /** All stored spans of the trace, ordered by start time. */
  spans: SpanRecord[];
}

export interface ErrorItem {
  traceId: string;
  spanId: string;
  spanName: string;
  spanKind: SpanKind;
  /** Route of the trace's root span, when it has one. */
  route?: string;
  method?: string;
  statusCode?: number;
  /** `exception.type` of the first exception event, or the span's status message. */
  errorType?: string;
  message?: string;
  timeUnixMs: number;
  /** Opaque paging cursor of this item. */
  cursor: string;
}

/** `GET api/v1/errors` */
export interface ErrorListResponse extends PagedResponse {
  items: ErrorItem[];
}

export interface RouteSeriesPoint {
  /** Start of the bucket, Unix ms. */
  timeUnixMs: number;
  count: number;
  errors: number;
  /** Percentile latencies of the bucket in ms; absent when `count` is 0. */
  p50Ms?: number;
  p95Ms?: number;
}

/** Per-route statistics, counted before sampling. */
export interface RouteStats {
  method: string;
  /** The route template, for example `/users/:id`. */
  route: string;
  count: number;
  /** 5xx or thrown handler; 4xx is not an error. */
  errors: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  series: RouteSeriesPoint[];
}

/** `GET api/v1/routes` */
export interface RouteStatsResponse {
  windowMinutes: number;
  /** Width of one series bucket in ms. */
  bucketMs: number;
  fromUnixMs: number;
  toUnixMs: number;
  routes: RouteStats[];
}

export type ApiErrorCode =
  | "bad_request"
  | "forbidden"
  | "not_found"
  | "internal";

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}
