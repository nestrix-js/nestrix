/** Response types of the Nestrix query API, version 1. Types only; no runtime code lives here except the version constant (see index.ts). */

import type { MetaProfiler } from "./profiles.js";

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
  /**
   * `service.name` of the span's own resource. The standalone server sets it on every span, so a
   * trace that crosses services keeps each span's service; the embedded API leaves it unset (the
   * whole store is one service, named in `meta.service`).
   */
  service?: string;
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
    windowMinutesOptions: number[];
  };
  warnings: ApiWarning[];
  /**
   * Where this API runs: inside one application (`embedded`) or in the standalone server
   * (`standalone`), which stores several services.
   */
  mode: "embedded" | "standalone";
  /**
   * Names of the services (`service.name`) with data in the store, sorted. Absent when the API
   * serves one application (`service.name` names it). Filter lists and statistics with `service`.
   */
  services?: string[];
  /** The on-demand CPU profiler (P7-02): `available: false` in the standalone server. */
  profiler: MetaProfiler;
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
  /**
   * What started the trace, from its root span: `http` when the root is a server span; `job` when
   * it is a consumer span or has `nestrix.entry = 'job'`; `scheduled` when it has
   * `nestrix.entry = 'scheduled'`; otherwise `other`.
   */
  type: TraceType;
  /**
   * True when any span of the trace is a consumer span or has `nestrix.entry = 'job'`, whatever
   * the root: a request that enqueued a job processed in the same trace has `type: "http"` and
   * `hasJob: true`.
   */
  hasJob: boolean;
  /** The release: `service.version` of the trace's resource, when set. */
  release?: string;
  /** `user.id` of the root span, when the app's `user` option recorded one. */
  user?: string;
  /** Opaque paging cursor of this item. */
  cursor: string;
}

/** What started a trace; see `TraceSummary.type`. */
export type TraceType = "http" | "job" | "scheduled" | "other";

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

/** Statistics of one method of one class (phase 3, D-56). */
export interface MethodStats {
  method: string;
  /** Calls counted before sampling. */
  calls: number;
  /** Calls that threw or whose promise rejected, counted before sampling. */
  errors: number;
  /** Sum of call durations in ms, counted before sampling. */
  totalMs: number;
  /** `totalMs / calls`; 0 when `calls` is 0. */
  avgMs: number;
  maxMs: number;
  /**
   * Own time per call in ms (duration minus time spent in child spans), estimated from the sampled
   * traces in the store; `null` when no sampled call of this method is in the store.
   */
  ownAvgMs: number | null;
}

/** Role of a traced class, as Nestrix recognises it. */
export type ClassKind =
  | "controller"
  | "service"
  | "repository"
  | "processor"
  | "provider"
  | "guard"
  | "pipe"
  | "interceptor"
  | "filter";

/** Statistics of one traced class: the sums over its methods. */
export interface ClassStats {
  className: string;
  kind: ClassKind;
  calls: number;
  errors: number;
  totalMs: number;
  avgMs: number;
  /** Own time in ms over the window, estimated as the sum over methods of `ownAvgMs * calls`; `null` when no method has an estimate. */
  ownMs: number | null;
  methods: MethodStats[];
}

/** `GET api/v1/classes` */
export interface ClassStatsResponse {
  windowMinutes: number;
  fromUnixMs: number;
  toUnixMs: number;
  /** False when method spans are off (no `NestrixInstrument`, or under `@nestjs/testing`); `classes` is then empty. */
  methodsEnabled: boolean;
  classes: ClassStats[];
}

export type MapNodeKind =
  | "app"
  | "database"
  | "cache"
  | "http"
  | "queue"
  | "other";

/** A node of the app map: the app itself, or something it calls. */
export interface MapNode {
  /** Stable within a response, e.g. `db:postgresql:localhost:5432/shop`. */
  id: string;
  kind: MapNodeKind;
  /** Display name, e.g. `postgresql shop`, `api.stripe.com`, `queue emails`. */
  name: string;
  /** `db.system.name`, `messaging.system`, or `http`. */
  system?: string;
}

/** Calls from one node to another, from the sampled spans in the store. */
export interface MapEdge {
  from: string;
  to: string;
  calls: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
}

/** `GET api/v1/map`: the app and what it calls (D-56), built from the traces in the store, so it reflects sampling. */
export interface AppMapResponse {
  windowMinutes: number;
  fromUnixMs: number;
  toUnixMs: number;
  nodes: MapNode[];
  edges: MapEdge[];
}

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "unavailable"
  | "internal"
  /** `409`: a profiler capture is already running. */
  | "conflict"
  /** `429`: a profiler capture started within 10 s of the previous one's end. */
  | "too_many_requests"
  /** `411`: a write without `Content-Length`. */
  | "length_required"
  /** `413`: a write body over its limit. */
  | "payload_too_large"
  /** `415`: a write that is not `application/json`. */
  | "unsupported_media_type";

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}
