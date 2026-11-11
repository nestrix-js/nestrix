/**
 * The query API shapes the store produces, mirrored from `@nestrix/protocol`
 * (`packages/protocol/src/types.ts`).
 *
 * Why a mirror: `@nestrix/protocol` is a devDependency of `@nestrix/nestjs` (private, never
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
  cursor: string;
}

export interface TraceListResponse extends PagedResponse {
  items: TraceSummary[];
}

export interface TraceResponse {
  traceId: string;
  rootSpanId: string;
  resource: Attributes;
  spans: SpanRecord[];
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
}

export interface ClassStatsResponse {
  windowMinutes: number;
  fromUnixMs: number;
  toUnixMs: number;
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
}

export interface AppMapResponse {
  windowMinutes: number;
  fromUnixMs: number;
  toUnixMs: number;
  nodes: MapNode[];
  edges: MapEdge[];
}
