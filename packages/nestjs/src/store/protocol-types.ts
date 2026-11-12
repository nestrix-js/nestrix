/**
 * The query API shapes the store produces, mirrored from `@nestrix-js/protocol`
 * (`packages/protocol/src/types.ts`).
 *
 * Why a mirror: `@nestrix-js/protocol` is a devDependency of `@nestrix-js/nestjs` (private, never
 * published), but a type-only import of it would need protocol's `dist` built before
 * `pnpm typecheck` in a fresh clone. So the shapes are mirrored here, and
 * `test/store-protocol.test.ts` fails `tsc` when they drift from protocol's built
 * declarations.
 *
 * Nothing here may be reachable from the package's public `index.d.ts`.
 */

export type AttributeScalar = string | number | boolean;
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

export interface SpanRecord {
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTimeUnixMs: number;
  durationMs: number;
  attributes: Attributes;
  events: SpanEvent[];
  status: { code: StatusCode; message?: string };
  links: SpanLink[];
  scope?: string;
  service?: string;
}

export interface PagedResponse {
  head: string | null;
  older: string | null;
  reset: boolean;
}

export interface TraceSummary {
  traceId: string;
  rootSpanId: string;
  name: string;
  method?: string;
  route?: string;
  statusCode?: number;
  error: boolean;
  startTimeUnixMs: number;
  durationMs: number;
  spanCount: number;
  type: TraceType;
  hasJob: boolean;
  release?: string;
  user?: string;
  cursor: string;
}

export type TraceType = "http" | "job" | "scheduled" | "other";

export interface TraceListResponse extends PagedResponse {
  items: TraceSummary[];
}

export interface TraceResponse {
  traceId: string;
  rootSpanId: string;
  resource: Attributes;
  spans: SpanRecord[];
  droppedSpans?: DroppedSpans;
}

export interface DroppedSpans {
  total: number;
  byKind: Record<string, number>;
  byServer: number;
}

export interface ErrorItem {
  traceId: string;
  spanId: string;
  spanName: string;
  spanKind: SpanKind;
  route?: string;
  method?: string;
  statusCode?: number;
  errorType?: string;
  message?: string;
  timeUnixMs: number;
  cursor: string;
}

export interface ErrorListResponse extends PagedResponse {
  items: ErrorItem[];
}

/** One stored error occurrence of a group. */
export interface ErrorGroupOccurrence {
  traceId: string;
  spanId: string;
  timeUnixMs: number;
  /** The raw message (already scrubbed at the source). */
  message?: string;
  service?: string;
}

export interface ErrorGroup {
  /** Stable within a response; identifies the group in lists. */
  key: string;
  errorType?: string;
  /**
   * The message with numbers, UUIDs, hex ids, quoted strings and email addresses replaced by
   * `<n>`, `<uuid>`, `<hex>`, `<str>` and `<email>`; empty when the errors carry no message.
   */
  pattern: string;
  /** Route of the trace's root span, when it has one. */
  route?: string;
  /** Occurrences in the window. */
  count: number;
  firstSeenUnixMs: number;
  lastSeenUnixMs: number;
  /** Occurrences per bucket, oldest first; `ErrorGroupsResponse.bucketMs` each, ending at the window's end. */
  series: number[];
  /** Services of the occurrences, sorted. */
  services: string[];
  /** Trace of the latest occurrence. */
  exampleTraceId: string;
  /** Raw message of the latest occurrence. */
  latestMessage?: string;
  /** Newest first, at most 10. */
  recent: ErrorGroupOccurrence[];
}

export interface ErrorGroupsResponse {
  windowMinutes: number;
  /** 60,000 for the 15-minute window, 300,000 for the 60-minute one. */
  bucketMs: number;
  fromUnixMs: number;
  toUnixMs: number;
  /** Most occurrences first, at most 100. */
  groups: ErrorGroup[];
}

/** Statistics of one method of one class (phase 3, D-56). */
export interface MethodStats {
  method: string;
  calls: number;
  errors: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  ownAvgMs: number | null;
}

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

export interface ClassStats {
  className: string;
  kind: ClassKind;
  calls: number;
  errors: number;
  totalMs: number;
  avgMs: number;
  ownMs: number | null;
  methods: MethodStats[];
  previous?: ClassStatsPrevious;
}

export interface ClassStatsPrevious {
  calls: number;
  errors: number;
  totalMs: number;
  avgMs: number;
  ownMs: number | null;
}

export interface ClassStatsPreviousTotals {
  classes: number;
  calls: number;
  errors: number;
  totalMs: number;
  ownMs: number | null;
}

export interface ClassStatsResponse {
  windowMinutes: number;
  fromUnixMs: number;
  toUnixMs: number;
  methodsState: "on" | "off" | "no-data-in-range";
  methodsEnabled: boolean;
  classes: ClassStats[];
  previousCovered?: boolean;
  note?: string | null;
  previousTotals?: ClassStatsPreviousTotals;
}

export type MapNodeKind =
  | "app"
  | "database"
  | "cache"
  | "http"
  | "queue"
  | "other";

export interface MapNode {
  id: string;
  kind: MapNodeKind;
  name: string;
  system?: string;
}

export interface MapEdge {
  from: string;
  to: string;
  calls: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
  previous?: MapEdgePrevious;
}

export interface MapEdgePrevious {
  calls: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
}

export interface AppMapPreviousTotals {
  targets: number;
  calls: number;
  errors: number;
  slowestP95Ms: number;
}

export interface AppMapResponse {
  windowMinutes: number;
  fromUnixMs: number;
  toUnixMs: number;
  nodes: MapNode[];
  edges: MapEdge[];
  previousCovered?: boolean;
  note?: string | null;
  previousTotals?: AppMapPreviousTotals;
}

export interface QueryStatement {
  statement: string;
  system: string;
  kind: "database" | "cache";
  count: number;
  totalMs: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  errors: number;
  traces: number;
  repeatedTraces: number;
  exampleTraceIds: string[];
}

export type QuerySort = "total" | "count" | "p95" | "max";

export interface QueryStatsResponse {
  windowMinutes: number;
  fromUnixMs: number;
  toUnixMs: number;
  sampled: true;
  truncated: boolean;
  queries: QueryStatement[];
}

// Mirror of `packages/protocol/src/dependencies.ts` (P9-05).
export interface DependencyPoint {
  startUnixMs: number;
  calls: number;
  p95Ms: number;
}

export interface DependencyStats {
  id: string;
  kind: MapNodeKind;
  name: string;
  system?: string;
  calls: number;
  errors: number;
  errorRate: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  exampleTraceId?: string;
  series: DependencyPoint[];
  previous?: DependencyPrevious;
}

export interface DependencyPrevious {
  calls: number;
  errors: number;
  errorRate: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface DependencyPreviousTotals {
  dependencies: number;
  calls: number;
  errors: number;
  slowestP95Ms: number;
}

export interface DependenciesResponse {
  windowMinutes: number;
  fromUnixMs: number;
  toUnixMs: number;
  bucketMs: number;
  dependencies: DependencyStats[];
  previousCovered?: boolean;
  note?: string | null;
  previousTotals?: DependencyPreviousTotals;
}

export interface TimelineBucket {
  startUnixMs: number;
  ok: number;
  clientError: number;
  serverError: number;
}

export interface TraceTimelineResponse {
  windowMinutes: number;
  fromUnixMs: number;
  toUnixMs: number;
  bucketMs: number;
  buckets: TimelineBucket[];
}

/** `packages/protocol/src/logs.ts` (P9-07). */
export interface TraceLogRecord {
  timeUnixMs: number;
  severity: number;
  level: string;
  context?: string;
  message: string;
  spanId?: string;
  service?: string;
}

export interface TraceLogsResponse {
  traceId: string;
  items: TraceLogRecord[];
  truncated: boolean;
}
