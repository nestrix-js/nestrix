/**
 * The query API over PostgreSQL: the embedded dashboard's routes (`packages/nestjs/src/dashboard/api.ts`)
 * with the same response shapes, reading the tables `src/storage` fills.
 *
 * - Trace list: the `traces` table by `seq` (newest first), cursor `t<seq in base 36>`.
 * - Errors: error spans from `spans`, newest first by (start time, trace id, span id), cursor
 *   `e.<start time, microseconds>.<trace id>.<span id>`.
 * - Trace by id: its spans and the root span's resource.
 * - Route and class statistics: `route_minutes` / `class_minutes` summed over the window; the
 *   percentiles are estimated from the summed latency histograms (`src/storage/histogram.ts`).
 * - Map: external targets of client and producer spans in the window, and an edge from service A
 *   to service B for every client or producer span in A whose child server or consumer span is in B.
 *
 * Cursors follow the embedded rules: a cursor that cannot be decoded answers `reset: true` with
 * the newest page, and so does an `after` cursor with more than one page of newer items. A cursor
 * does not name the process (the position is in the database), so it survives a restart.
 * `after` on errors orders by start time: an error span that arrives late with an older start time
 * is not delivered to a poller that is already past it.
 */
import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type {
  AppMapResponse,
  Attributes,
  ClassKind,
  ClassStats,
  ClassStatsResponse,
  DependenciesResponse,
  DependencyStats,
  ErrorGroupsResponse,
  ErrorItem,
  ErrorListResponse,
  MapEdge,
  MapNode,
  MetaResponse,
  MethodStats,
  QuerySort,
  QueryStatsResponse,
  RouteHistogramResponse,
  RouteReleaseCompareResponse,
  RouteSeriesPoint,
  RouteStats,
  RouteStatsResponse,
  RouteWindowCompareResponse,
  SpanKind,
  SpanRecord,
  StatusCode,
  TraceListResponse,
  TraceResponse,
  TraceSummary,
  TraceTimelineResponse,
  TraceType,
} from "@nestrix-js/protocol";
import type pg from "pg";
import type { ServerConfig } from "../config.js";
import { SERVER_CONFIG } from "../config.module.js";
import {
  addHistograms,
  emptyHistogram,
  estimateQuantile,
  HISTOGRAM_BUCKETS,
  HISTOGRAM_UPPER_BOUNDS_MS,
} from "../storage/histogram.js";
import { STORAGE_POOL } from "../storage/storage.module.js";
import { droppedSpansOf } from "./dropped-spans.js";
import { type ErrorOccurrence, groupErrors } from "./error-groups.js";
import { QUERY_OPTIONS, type ResolvedQueryOptions } from "./options.js";
import { routeStatsSpec, type Values } from "./params.js";
import {
  uncovered,
  withPreviousClasses,
  withPreviousDependencies,
  withPreviousMap,
} from "./previous-window.js";
import { queriesSql } from "./queries-sql.js";
import {
  bucketsOf,
  compareRows,
  type ReleaseRow,
  releaseCompareSql,
  releaseSides,
  releasesSql,
  type SideRow,
} from "./route-insights.js";
import { TARGET_KEYS, targetOf } from "./targets.js";

export const PROTOCOL_VERSION: MetaResponse["protocolVersion"] = 1;

const CACHE_SYSTEMS = new Set(["redis", "valkey", "memcached"]);

/** Nodes in one map response; targets past it fold into one `other` node (as the embedded map). */
export const MAX_MAP_NODES = 200;
const OVERFLOW_ID = "other:overflow";
const MINUTE_MS = 60_000;
/** Targets in one dependencies response; those with the least total time are left out. */
export const MAX_DEPENDENCIES = 200;

/** Bucket width of a window: 1 minute for 15 minutes, 5 minutes for 60. */
const bucketMsFor = (windowMinutes: number): number =>
  (windowMinutes <= 15 ? 1 : 5) * MINUTE_MS;
/** Clock skew allowed between a calling span and its remote child when joining them. */
const SKEW_MS = MINUTE_MS;
const CLASS_KINDS: ReadonlySet<string> = new Set<ClassKind>([
  "controller",
  "service",
  "repository",
  "processor",
  "provider",
  "guard",
  "pipe",
  "interceptor",
  "filter",
]);

/** A request whose parameters are fine but whose target does not exist (404). */
export class NotFoundError extends Error {}

/** Unix nanoseconds (a `bigint` column, a string from `pg`) as fractional ms, to microseconds. */
function msOf(ns: string | bigint | number): number {
  return Number(BigInt(ns) / 1000n) / 1000;
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/** Bound parameters of one statement; `add` returns the placeholder to put in the text. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** `count(*) FILTER` columns h0..h29: the latency histogram of `column` (nanoseconds). */
function histogramColumns(column: string): string {
  const ms = `(${column}::float8 / 1e6)`;
  const out: string[] = [];
  for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
    const lo = i === 0 ? undefined : HISTOGRAM_UPPER_BOUNDS_MS[i - 1];
    const hi =
      i === HISTOGRAM_BUCKETS - 1 ? undefined : HISTOGRAM_UPPER_BOUNDS_MS[i];
    const conditions: string[] = [];
    if (lo !== undefined) conditions.push(`${ms} > ${lo}`);
    if (hi !== undefined) conditions.push(`${ms} <= ${hi}`);
    out.push(
      `count(*) FILTER (WHERE ${conditions.join(" AND ")})::int AS h${i}`,
    );
  }
  return out.join(", ");
}

function histogramOf(row: Record<string, unknown>): number[] {
  const hist = emptyHistogram();
  for (let i = 0; i < HISTOGRAM_BUCKETS; i++) hist[i] = Number(row[`h${i}`]);
  return hist;
}

interface Window {
  /** Minute index (Unix ms / 60 000) of the first and last minute of the window. */
  first: number;
  last: number;
  fromMs: number;
  toMs: number;
}

function windowOf(windowMinutes: number, now: number): Window {
  const last = Math.floor(now / MINUTE_MS);
  const first = last - windowMinutes + 1;
  return { first, last, fromMs: first * MINUTE_MS, toMs: now };
}

const T_CURSOR = /^t([0-9a-z]{1,13})$/;
const E_CURSOR =
  /^e\.(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z)\.([0-9a-f]{32})\.([0-9a-f]{16})$/;

function traceCursor(seq: number | string): string {
  return `t${Number(seq).toString(36)}`;
}

function decodeTraceCursor(cursor: string): number | undefined {
  const m = T_CURSOR.exec(cursor);
  if (m === null) return undefined;
  const seq = Number.parseInt(m[1] as string, 36);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
}

interface ErrorPosition {
  ts: string;
  traceId: string;
  spanId: string;
}

function errorCursor(p: {
  ts: string;
  trace_id: string;
  span_id: string;
}): string {
  return `e.${p.ts}.${p.trace_id}.${p.span_id}`;
}

function decodeErrorCursor(cursor: string): ErrorPosition | undefined {
  const m = E_CURSOR.exec(cursor);
  if (m === null) return undefined;
  return {
    ts: m[1] as string,
    traceId: m[2] as string,
    spanId: m[3] as string,
  };
}

const TS_SQL = `to_char(%s AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface SummaryRow {
  trace_id: string;
  seq: string;
  root_span_id: string;
  name: string;
  http_method: string | null;
  http_route: string | null;
  http_status: number | null;
  is_error: boolean;
  start_ns: string;
  duration_ns: string;
  span_count: number;
  trace_type: TraceType;
  has_job: boolean;
  release: string | null;
  user_id: string | null;
}

function summaryOf(r: SummaryRow): TraceSummary {
  const item: TraceSummary = {
    traceId: r.trace_id,
    rootSpanId: r.root_span_id,
    name: r.name,
    error: r.is_error,
    startTimeUnixMs: msOf(r.start_ns),
    durationMs: msOf(r.duration_ns),
    spanCount: r.span_count,
    type: r.trace_type,
    hasJob: r.has_job,
    cursor: traceCursor(r.seq),
  };
  if (r.http_method !== null) item.method = r.http_method;
  if (r.http_route !== null) item.route = r.http_route;
  if (r.http_status !== null) item.statusCode = r.http_status;
  if (r.release !== null) item.release = r.release;
  if (r.user_id !== null) item.user = r.user_id;
  return item;
}

interface SpanRow {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: SpanKind;
  start_ns: string;
  duration_ns: string;
  status_code: StatusCode;
  status_message: string | null;
  scope: string | null;
  /** The span's own resource's `service.name`; selected by `getTrace` only. */
  service_name?: string;
  attributes: Attributes;
  events: { name: string; timeUnixNano: string; attributes: Attributes }[];
  links: { traceId: string; spanId: string }[];
}

function spanOf(r: SpanRow): SpanRecord {
  const status: SpanRecord["status"] = { code: r.status_code };
  if (r.status_message !== null) status.message = r.status_message;
  const span: SpanRecord = {
    spanId: r.span_id,
    name: r.name,
    kind: r.kind,
    startTimeUnixMs: msOf(r.start_ns),
    durationMs: msOf(r.duration_ns),
    attributes: r.attributes,
    events: r.events.map((e) => ({
      name: e.name,
      timeUnixMs: msOf(e.timeUnixNano),
      attributes: e.attributes,
    })),
    status,
    links: r.links.map((l) => ({ traceId: l.traceId, spanId: l.spanId })),
  };
  if (r.parent_span_id !== null) span.parentSpanId = r.parent_span_id;
  if (r.scope !== null) span.scope = r.scope;
  if (r.service_name !== undefined) span.service = r.service_name;
  return span;
}

/** Depth of each span below a local root (a span whose parent is not stored is at 0). */
function depthsOf(spans: readonly SpanRecord[]): Map<SpanRecord, number> {
  const byId = new Map<string, SpanRecord>();
  for (const s of spans) byId.set(s.spanId, s);
  const out = new Map<SpanRecord, number>();
  for (const s of spans) {
    let depth = 0;
    let cursor: SpanRecord | undefined = s;
    // The step cap guards against a parent cycle in forged ids.
    while (
      cursor?.parentSpanId !== undefined &&
      byId.has(cursor.parentSpanId) &&
      depth <= spans.length
    ) {
      cursor = byId.get(cursor.parentSpanId);
      depth++;
    }
    out.set(s, depth);
  }
  return out;
}

@Injectable()
export class QueryService {
  /** Random per process, like the embedded store's. Cursors do not carry it. */
  readonly processId = randomBytes(8).toString("hex");
  private statsCache: { at: number; value: MetaResponse["store"] } | undefined;

  constructor(
    @Inject(STORAGE_POOL) private readonly pool: pg.Pool,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @Inject(QUERY_OPTIONS) private readonly options: ResolvedQueryOptions,
  ) {}

  private async rows<T>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query(text, params as unknown[]);
    return result.rows as T[];
  }

  // ---- meta ------------------------------------------------------------------------------------

  private async storeStats(now: number): Promise<MetaResponse["store"]> {
    const ttl = this.options.statsCacheMs;
    if (this.statsCache !== undefined && now - this.statsCache.at < ttl) {
      return this.statsCache.value;
    }
    const [row] = await this.rows<{
      traces: string;
      spans: string;
      bytes: string;
    }>(
      `SELECT (SELECT count(*) FROM traces) AS traces,
              (SELECT count(*) FROM spans) AS spans,
              (SELECT coalesce(sum(pg_total_relation_size(i.inhrelid)), 0)
                 FROM pg_inherits i
                WHERE i.inhparent IN ('spans'::regclass, 'traces'::regclass)) AS bytes`,
    );
    const value = {
      traces: Number(row?.traces ?? 0),
      spans: Number(row?.spans ?? 0),
      bytes: Number(row?.bytes ?? 0),
      // The database has no size or count limit of its own; retention is by day.
      maxTraces: 0,
      maxBytes: 0,
      evictedTraces: 0,
      droppedSpans: 0,
    };
    this.statsCache = { at: now, value };
    return value;
  }

  /** Service names with data within the retention window, sorted. */
  async serviceNames(now: number): Promise<string[]> {
    const since = new Date(now - this.config.retentionDays * 86_400_000);
    const rows = await this.rows<{ name: string }>(
      "SELECT name FROM services WHERE last_seen >= $1 ORDER BY name",
      [since],
    );
    return rows.map((r) => r.name);
  }

  async meta(now: number = Date.now()): Promise<MetaResponse> {
    const [store, services, since] = await Promise.all([
      this.storeStats(now),
      this.serviceNames(now),
      this.rows<{ since: string | null }>(
        "SELECT (extract(epoch FROM min(minute)) * 1000)::bigint AS since FROM route_minutes",
      ),
    ]);
    const sinceMs = since[0]?.since;
    return {
      protocolVersion: PROTOCOL_VERSION,
      processId: this.processId,
      serverTimeUnixMs: now,
      service: {},
      sampling: { owner: "host", rate: null },
      store,
      statistics: {
        sinceUnixMs: sinceMs == null ? now : Number(sinceMs),
        windowMinutesOptions: [...routeStatsSpec.windowMinutes.oneOf],
      },
      warnings: [],
      mode: "standalone",
      services,
      // The embedded profiler profiles the process it runs in, so it is not offered here; instances
      // that opted in are profiled remotely (P10-02, D-76: `instances`, `remote-profiles`).
      profiler: { available: false, running: false, remote: true },
      // Process runtime samples exist only in the embedded dashboard.
      runtime: { available: false },
    };
  }

  // ---- traces ----------------------------------------------------------------------------------

  /** The `WHERE` conditions of the trace list's filters, shared by the list and the timeline. */
  private traceWhere(v: Values, params: Params): string[] {
    const where: string[] = [];
    if (v.route !== undefined)
      where.push(`http_route = ${params.add(v.route)}`);
    // `job` means "has job processing" (any root); the other types are root-based.
    if (v.type === "job") where.push("has_job");
    else if (v.type !== undefined)
      where.push(`trace_type = ${params.add(v.type)}`);
    if (v.release !== undefined)
      where.push(`release = ${params.add(v.release)}`);
    if (v.user !== undefined) where.push(`user_id = ${params.add(v.user)}`);
    if (v.service !== undefined)
      where.push(`service_name = ${params.add(v.service)}`);
    if (v.method !== undefined) {
      where.push(
        `upper(http_method) = ${params.add(String(v.method).toUpperCase())}`,
      );
    }
    if (v.minDurationMs !== undefined) {
      where.push(
        `duration_ns::float8 >= ${params.add(Number(v.minDurationMs) * 1e6)}::float8`,
      );
    }
    if (v.maxDurationMs !== undefined) {
      where.push(
        `duration_ns::float8 <= ${params.add(Number(v.maxDurationMs) * 1e6)}::float8`,
      );
    }
    switch (v.status) {
      case "error":
        where.push("is_error");
        break;
      case "ok":
        where.push(
          "(NOT is_error AND (http_status IS NULL OR http_status < 400))",
        );
        break;
      case "4xx":
        where.push("http_status BETWEEN 400 AND 499");
        break;
      case "5xx":
        where.push("http_status BETWEEN 500 AND 599");
        break;
    }
    if (v.search !== undefined) {
      const needle = params.add(String(v.search).toLowerCase());
      where.push(
        `(position(${needle} in lower(coalesce(http_route, ''))) > 0
          OR EXISTS (SELECT 1 FROM unnest(span_names) AS n WHERE position(${needle} in lower(n)) > 0))`,
      );
    }
    if (v.fromUnixMs !== undefined) {
      where.push(`start_time >= ${params.add(new Date(Number(v.fromUnixMs)))}`);
    }
    if (v.toUnixMs !== undefined) {
      where.push(`start_time <= ${params.add(new Date(Number(v.toUnixMs)))}`);
    }
    return where;
  }

  async listTraces(v: Values): Promise<TraceListResponse> {
    const limit = v.limit as number;
    const params = new Params();
    const where = this.traceWhere(v, params);
    let reset = false;
    let cursorCondition: string | undefined;
    if (v.before !== undefined) {
      const seq = decodeTraceCursor(String(v.before));
      if (seq === undefined) reset = true;
      else cursorCondition = `seq < ${params.add(seq)}`;
    } else if (v.after !== undefined) {
      const seq = decodeTraceCursor(String(v.after));
      if (seq === undefined) reset = true;
      else cursorCondition = `seq > ${params.add(seq)}`;
    }
    const conditions = cursorCondition ? [...where, cursorCondition] : where;
    const text = `SELECT trace_id, seq::text AS seq, root_span_id, name, http_method, http_route, http_status,
                         is_error, start_ns::text AS start_ns, duration_ns::text AS duration_ns,
                         span_count, trace_type, has_job, release, user_id
                    FROM traces
                   ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
                   ORDER BY seq DESC
                   LIMIT ${params.add(limit + 1)}`;
    const [rows, head] = await Promise.all([
      this.rows<SummaryRow>(text, params.values),
      this.rows<{ seq: string | null }>(
        "SELECT max(seq)::text AS seq FROM traces",
      ),
    ]);
    // More newer items than one page: the poller cannot catch up without a gap.
    if (
      v.after !== undefined &&
      cursorCondition !== undefined &&
      rows.length > limit
    ) {
      reset = true;
    }
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const more = rows.length > limit;
    const headSeq = head[0]?.seq;
    return {
      items: page.map(summaryOf),
      head: headSeq == null ? null : traceCursor(headSeq),
      older: more && last ? traceCursor(last.seq) : null,
      reset,
    };
  }

  async getTrace(traceId: string): Promise<TraceResponse> {
    const spanRows = await this.rows<SpanRow & { resource_id: string }>(
      `SELECT span_id, parent_span_id, name, kind, start_ns::text AS start_ns,
              duration_ns::text AS duration_ns, status_code, status_message, scope,
              attributes, events, links, resource_id::text AS resource_id, service_name
         FROM spans WHERE trace_id = $1`,
      [traceId],
    );
    if (spanRows.length === 0) {
      throw new NotFoundError("No trace with this id is stored.");
    }
    const records = spanRows.map(spanOf);
    const depths = depthsOf(records);
    // By start time; on a tie a parent before its descendants.
    const order = records
      .map((span, i) => ({ span, i }))
      .sort(
        (a, b) =>
          a.span.startTimeUnixMs - b.span.startTimeUnixMs ||
          (depths.get(a.span) ?? 0) - (depths.get(b.span) ?? 0),
      );
    const spans = order.map((o) => o.span);
    const [summary] = await this.rows<{
      root_span_id: string;
      resource_id: string;
      dropped_spans: string;
    }>(
      "SELECT root_span_id, resource_id::text AS resource_id, dropped_spans::text AS dropped_spans FROM traces WHERE trace_id = $1 LIMIT 1",
      [traceId],
    );
    let rootSpanId = summary?.root_span_id;
    if (rootSpanId === undefined) {
      rootSpanId = (spans.find((s) => depths.get(s) === 0) ?? spans[0])?.spanId;
    }
    const resourceId =
      summary?.resource_id ??
      (spanRows.find((r) => r.span_id === rootSpanId) ?? spanRows[0])
        ?.resource_id;
    const [resource] = await this.rows<{ attributes: Attributes }>(
      "SELECT attributes FROM resources WHERE id = $1",
      [resourceId],
    );
    const response: TraceResponse = {
      traceId,
      rootSpanId: rootSpanId ?? "",
      resource: resource?.attributes ?? {},
      spans,
    };
    const droppedSpans = droppedSpansOf(
      spans,
      Number(summary?.dropped_spans ?? 0),
    );
    if (droppedSpans !== undefined) response.droppedSpans = droppedSpans;
    return response;
  }

  // ---- errors ----------------------------------------------------------------------------------

  async listErrors(v: Values): Promise<ErrorListResponse> {
    const limit = v.limit as number;
    const params = new Params();
    const where: string[] = ["s.is_error"];
    if (v.service !== undefined) {
      where.push(`s.service_name = ${params.add(v.service)}`);
    }
    if (v.route !== undefined) {
      where.push(
        `EXISTS (SELECT 1 FROM traces t WHERE t.trace_id = s.trace_id AND t.http_route = ${params.add(v.route)})`,
      );
    }
    const position = (cursor: ErrorPosition, operator: "<" | ">"): string =>
      `(s.start_time, s.trace_id, s.span_id) ${operator} (${params.add(cursor.ts)}::timestamptz, ${params.add(cursor.traceId)}, ${params.add(cursor.spanId)})`;

    let reset = false;
    let cursorCondition: string | undefined;
    if (v.before !== undefined) {
      const at = decodeErrorCursor(String(v.before));
      if (at === undefined) reset = true;
      else cursorCondition = position(at, "<");
    } else if (v.after !== undefined) {
      const at = decodeErrorCursor(String(v.after));
      if (at === undefined) reset = true;
      else cursorCondition = position(at, ">");
    }
    const conditions = cursorCondition ? [...where, cursorCondition] : where;
    const select = `SELECT s.trace_id, s.span_id, s.name, s.kind, s.status_message, s.events,
                           s.start_ns::text AS start_ns, s.end_ns::text AS end_ns,
                           s.http_route, s.http_method, s.http_status,
                           ${TS_SQL.replace("%s", "s.start_time")} AS ts
                      FROM spans s`;
    const order = "ORDER BY s.start_time DESC, s.trace_id DESC, s.span_id DESC";
    const [rows, head] = await Promise.all([
      this.rows<ErrorRow>(
        `${select} WHERE ${conditions.join(" AND ")} ${order} LIMIT ${params.add(limit + 1)}`,
        params.values,
      ),
      this.rows<{ trace_id: string; span_id: string; ts: string }>(
        `SELECT s.trace_id, s.span_id, ${TS_SQL.replace("%s", "s.start_time")} AS ts
           FROM spans s WHERE s.is_error ${order} LIMIT 1`,
      ),
    ]);
    if (
      v.after !== undefined &&
      cursorCondition !== undefined &&
      rows.length > limit
    ) {
      reset = true;
    }
    const page = rows.slice(0, limit);
    const roots = new Map<
      string,
      {
        http_route: string | null;
        http_method: string | null;
        http_status: number | null;
      }
    >();
    if (page.length > 0) {
      const found = await this.rows<{
        trace_id: string;
        http_route: string | null;
        http_method: string | null;
        http_status: number | null;
      }>(
        "SELECT trace_id, http_route, http_method, http_status FROM traces WHERE trace_id = ANY($1)",
        [[...new Set(page.map((r) => r.trace_id))]],
      );
      for (const r of found) roots.set(r.trace_id, r);
    }
    const items = page.map((r) => errorItemOf(r, roots.get(r.trace_id)));
    const last = page[page.length - 1];
    const newest = head[0];
    return {
      items,
      head: newest ? errorCursor(newest) : null,
      older: rows.length > limit && last ? errorCursor(last) : null,
      reset,
    };
  }

  // ---- error groups ------------------------------------------------------------------------------

  /** Error spans of the window grouped by (type, normalised message, route); the newest 5,000 are read. */
  async errorGroups(
    windowMinutes: number,
    service: string | undefined,
    now: number = Date.now(),
  ): Promise<ErrorGroupsResponse> {
    const empty = groupErrors([], windowMinutes, now);
    const params = new Params();
    const where = [
      "s.is_error",
      `s.start_time >= ${params.add(new Date(empty.fromUnixMs))}`,
    ];
    if (service !== undefined) {
      where.push(`s.service_name = ${params.add(service)}`);
    }
    const rows = await this.rows<
      ErrorRow & {
        service_name: string | null;
        root_route: string | null;
        root_method: string | null;
        root_status: number | null;
      }
    >(
      `SELECT s.trace_id, s.span_id, s.name, s.kind, s.status_message, s.events,
              s.start_ns::text AS start_ns, s.end_ns::text AS end_ns,
              s.http_route, s.http_method, s.http_status, s.service_name,
              t.http_route AS root_route, t.http_method AS root_method, t.http_status AS root_status
         FROM spans s LEFT JOIN traces t ON t.trace_id = s.trace_id
        WHERE ${where.join(" AND ")}
        ORDER BY s.start_time DESC, s.trace_id DESC, s.span_id DESC
        LIMIT 5000`,
      params.values,
    );
    return groupErrors(
      rows.map((r): ErrorOccurrence => {
        const hasRoot =
          r.root_route !== null ||
          r.root_method !== null ||
          r.root_status !== null;
        const item = errorItemOf(
          r,
          hasRoot
            ? {
                http_route: r.root_route,
                http_method: r.root_method,
                http_status: r.root_status,
              }
            : undefined,
        );
        return {
          traceId: item.traceId,
          spanId: item.spanId,
          timeUnixMs: item.timeUnixMs,
          errorType: item.errorType,
          message: item.message,
          route: item.route,
          service: r.service_name ?? undefined,
        };
      }),
      windowMinutes,
      now,
    );
  }

  // ---- route statistics ------------------------------------------------------------------------

  async routes(
    windowMinutes: number,
    service: string | undefined,
    now: number = Date.now(),
  ): Promise<RouteStatsResponse> {
    const w = windowOf(windowMinutes, now);
    const params = new Params();
    const where = [
      `minute >= ${params.add(new Date(w.first * MINUTE_MS))}`,
      `minute <= ${params.add(new Date(w.last * MINUTE_MS))}`,
    ];
    if (service !== undefined) {
      where.push(`service_name = ${params.add(service)}`);
    }
    const rows = await this.rows<{
      minute_ms: string;
      method: string;
      route: string;
      count: number;
      errors: number;
      max_ms: number;
      hist: number[];
    }>(
      `SELECT (extract(epoch FROM minute) * 1000)::bigint AS minute_ms, method, route, count, errors, max_ms, hist
         FROM route_minutes WHERE ${where.join(" AND ")}`,
      params.values,
    );
    interface Cell {
      count: number;
      errors: number;
      max: number;
      hist: number[];
    }
    interface Series extends Cell {
      method: string;
      route: string;
      byMinute: Map<number, Cell>;
    }
    const byRoute = new Map<string, Series>();
    const add = (
      into: Cell,
      count: number,
      errors: number,
      max: number,
      hist: readonly number[],
    ) => {
      into.count += count;
      into.errors += errors;
      if (max > into.max) into.max = max;
      addHistograms(into.hist, hist);
    };
    for (const r of rows) {
      const key = `${r.method}\u0000${r.route}`;
      let s = byRoute.get(key);
      if (s === undefined) {
        s = {
          method: r.method,
          route: r.route,
          count: 0,
          errors: 0,
          max: 0,
          hist: emptyHistogram(),
          byMinute: new Map(),
        };
        byRoute.set(key, s);
      }
      add(s, r.count, r.errors, r.max_ms, r.hist);
      const minute = Math.floor(Number(r.minute_ms) / MINUTE_MS);
      let cell = s.byMinute.get(minute);
      if (cell === undefined) {
        cell = { count: 0, errors: 0, max: 0, hist: emptyHistogram() };
        s.byMinute.set(minute, cell);
      }
      add(cell, r.count, r.errors, r.max_ms, r.hist);
    }
    const routes: RouteStats[] = [];
    for (const s of byRoute.values()) {
      if (s.count === 0) continue;
      const series: RouteSeriesPoint[] = [];
      for (let m = w.first; m <= w.last; m++) {
        const cell = s.byMinute.get(m);
        const point: RouteSeriesPoint = {
          timeUnixMs: m * MINUTE_MS,
          count: cell?.count ?? 0,
          errors: cell?.errors ?? 0,
        };
        if (cell !== undefined && cell.count > 0) {
          point.p50Ms = estimateQuantile(cell.hist, cell.count, 0.5, cell.max);
          point.p95Ms = estimateQuantile(cell.hist, cell.count, 0.95, cell.max);
        }
        series.push(point);
      }
      routes.push({
        method: s.method,
        route: s.route,
        count: s.count,
        errors: s.errors,
        p50Ms: estimateQuantile(s.hist, s.count, 0.5, s.max),
        p95Ms: estimateQuantile(s.hist, s.count, 0.95, s.max),
        p99Ms: estimateQuantile(s.hist, s.count, 0.99, s.max),
        maxMs: round(s.max),
        series,
      });
    }
    routes.sort(
      (a, b) =>
        b.count - a.count ||
        (a.route < b.route ? -1 : a.route > b.route ? 1 : 0) ||
        (a.method < b.method ? -1 : a.method > b.method ? 1 : 0),
    );
    return {
      windowMinutes,
      bucketMs: MINUTE_MS,
      fromUnixMs: w.fromMs,
      toUnixMs: now,
      routes,
    };
  }

  // ---- route insights (P9-02) ------------------------------------------------------------------

  async routeHistogram(
    route: string,
    method: string | undefined,
    windowMinutes: number,
    service: string | undefined,
    now: number = Date.now(),
  ): Promise<RouteHistogramResponse> {
    const w = windowOf(windowMinutes, now);
    const params = new Params();
    const where = [
      `minute >= ${params.add(new Date(w.first * MINUTE_MS))}`,
      `minute <= ${params.add(new Date(w.last * MINUTE_MS))}`,
      `route = ${params.add(route)}`,
    ];
    if (method !== undefined) where.push(`method = ${params.add(method)}`);
    if (service !== undefined) {
      where.push(`service_name = ${params.add(service)}`);
    }
    const rows = await this.rows<{
      count: number;
      max_ms: number;
      hist: number[];
    }>(
      `SELECT count, max_ms, hist FROM route_minutes WHERE ${where.join(" AND ")}`,
      params.values,
    );
    const hist = emptyHistogram();
    let count = 0;
    let max = 0;
    for (const r of rows) {
      count += Number(r.count);
      if (Number(r.max_ms) > max) max = Number(r.max_ms);
      addHistograms(hist, r.hist);
    }
    return {
      method: method ?? null,
      route,
      windowMinutes,
      fromUnixMs: w.fromMs,
      toUnixMs: now,
      count,
      p50Ms: estimateQuantile(hist, count, 0.5, max),
      p95Ms: estimateQuantile(hist, count, 0.95, max),
      p99Ms: estimateQuantile(hist, count, 0.99, max),
      maxMs: round(max),
      buckets: bucketsOf(hist),
    };
  }

  async windowCompare(
    windowMinutes: number,
    service: string | undefined,
    now: number = Date.now(),
  ): Promise<RouteWindowCompareResponse> {
    const last = Math.floor(now / MINUTE_MS);
    const curFirst = last - windowMinutes + 1;
    const prevLast = curFirst - 1;
    const prevFirst = prevLast - windowMinutes + 1;
    const params = new Params();
    const where = [
      `minute >= ${params.add(new Date(prevFirst * MINUTE_MS))}`,
      `minute <= ${params.add(new Date(last * MINUTE_MS))}`,
    ];
    if (service !== undefined) {
      where.push(`service_name = ${params.add(service)}`);
    }
    const rows = await this.rows<{
      minute_ms: string;
      method: string;
      route: string;
      count: number;
      errors: number;
      max_ms: number;
      hist: number[];
    }>(
      `SELECT (extract(epoch FROM minute) * 1000)::bigint AS minute_ms, method, route, count, errors, max_ms, hist
         FROM route_minutes WHERE ${where.join(" AND ")}`,
      params.values,
    );
    interface Acc {
      method: string;
      route: string;
      count: number;
      errors: number;
      max: number;
      hist: number[];
    }
    const before = new Map<string, Acc>();
    const after = new Map<string, Acc>();
    for (const r of rows) {
      const minute = Math.floor(Number(r.minute_ms) / MINUTE_MS);
      const into = minute >= curFirst ? after : before;
      const key = `${r.method}\u0000${r.route}`;
      let a = into.get(key);
      if (a === undefined) {
        a = {
          method: r.method,
          route: r.route,
          count: 0,
          errors: 0,
          max: 0,
          hist: emptyHistogram(),
        };
        into.set(key, a);
      }
      a.count += Number(r.count);
      a.errors += Number(r.errors);
      if (Number(r.max_ms) > a.max) a.max = Number(r.max_ms);
      addHistograms(a.hist, r.hist);
    }
    const sides = (m: Map<string, Acc>): SideRow[] =>
      [...m.values()]
        .filter((a) => a.count > 0)
        .map((a) => ({
          method: a.method,
          route: a.route,
          count: a.count,
          errors: a.errors,
          p50Ms: estimateQuantile(a.hist, a.count, 0.5, a.max),
          p95Ms: estimateQuantile(a.hist, a.count, 0.95, a.max),
        }));
    const sinceParams = new Params();
    const sinceWhere =
      service === undefined
        ? ""
        : `WHERE service_name = ${sinceParams.add(service)}`;
    const [since, releases] = await Promise.all([
      this.rows<{ since: string | null }>(
        `SELECT (extract(epoch FROM min(minute)) * 1000)::bigint AS since FROM route_minutes ${sinceWhere}`,
        sinceParams.values,
      ),
      this.releases(service),
    ]);
    const sinceMs = since[0]?.since;
    const covered = sinceMs != null && Number(sinceMs) <= prevFirst * MINUTE_MS;
    return {
      mode: "window",
      windowMinutes,
      previous: {
        fromUnixMs: prevFirst * MINUTE_MS,
        toUnixMs: curFirst * MINUTE_MS,
      },
      current: { fromUnixMs: curFirst * MINUTE_MS, toUnixMs: now },
      previousCovered: covered,
      note: covered
        ? null
        : "Statistics start less than two windows ago, so the previous window is only partly counted or empty.",
      releases,
      routes: compareRows(sides(before), sides(after)),
    };
  }

  async releaseCompare(
    releaseA: string,
    releaseB: string,
    service: string | undefined,
  ): Promise<RouteReleaseCompareResponse> {
    const q = releaseCompareSql(releaseA, releaseB, service);
    const [rows, releases] = await Promise.all([
      this.rows<ReleaseRow>(q.text, q.values),
      this.releases(service),
    ]);
    const sides = releaseSides(rows, releaseA, releaseB);
    return {
      mode: "release",
      releaseA,
      releaseB,
      releases,
      routes: compareRows(sides.a, sides.b),
    };
  }

  private async releases(service: string | undefined): Promise<string[]> {
    const q = releasesSql(service);
    const rows = await this.rows<{ release: string }>(q.text, q.values);
    return rows.map((r) => r.release);
  }

  // ---- previous windows (P15-01) ---------------------------------------------------------------

  /** When the first route statistics of the service were kept; `undefined` without any. */
  private async statisticsSince(
    service: string | undefined,
  ): Promise<number | undefined> {
    const p = new Params();
    const where =
      service === undefined ? "" : `WHERE service_name = ${p.add(service)}`;
    const [row] = await this.rows<{ since: string | null }>(
      `SELECT (extract(epoch FROM min(minute)) * 1000)::bigint AS since FROM route_minutes ${where}`,
      p.values,
    );
    return row?.since == null ? undefined : Number(row.since);
  }

  /** Whether statistics reach back to the start of the window before the one starting at `fromMs`. */
  private async coversPrevious(
    windowMinutes: number,
    fromMs: number,
    service: string | undefined,
  ): Promise<boolean> {
    const since = await this.statisticsSince(service);
    return since !== undefined && since <= fromMs - windowMinutes * MINUTE_MS;
  }

  /** `classes` with the previous window (the same query for the window before), or why not. */
  async classesWithPrevious(
    windowMinutes: number,
    service: string | undefined,
    now: number = Date.now(),
  ): Promise<ClassStatsResponse> {
    const current = await this.classes(windowMinutes, service, now);
    if (
      !(await this.coversPrevious(windowMinutes, current.fromUnixMs, service))
    ) {
      return uncovered(current);
    }
    const before = current.fromUnixMs - 1;
    return withPreviousClasses(
      current,
      await this.classes(windowMinutes, service, before, before),
    );
  }

  /** `dependencies` with the previous window, or why not. */
  async dependenciesWithPrevious(
    windowMinutes: number,
    service: string | undefined,
    now: number = Date.now(),
  ): Promise<DependenciesResponse> {
    const current = await this.dependencies(windowMinutes, service, now);
    if (
      !(await this.coversPrevious(windowMinutes, current.fromUnixMs, service))
    ) {
      return uncovered(current);
    }
    return withPreviousDependencies(
      current,
      await this.dependencies(windowMinutes, service, current.fromUnixMs - 1),
    );
  }

  /** `map` with the previous window, or why not. */
  async mapWithPrevious(
    windowMinutes: number,
    service: string | undefined,
    now: number = Date.now(),
  ): Promise<AppMapResponse> {
    const current = await this.map(windowMinutes, service, now);
    if (
      !(await this.coversPrevious(windowMinutes, current.fromUnixMs, service))
    ) {
      return uncovered(current);
    }
    return withPreviousMap(
      current,
      await this.map(windowMinutes, service, current.fromUnixMs - 1),
    );
  }

  // ---- class statistics ------------------------------------------------------------------------

  async classes(
    windowMinutes: number,
    service: string | undefined,
    now: number = Date.now(),
    /** Count own time only from spans that started by then (the previous window's end). */
    ownUntilMs?: number,
  ): Promise<ClassStatsResponse> {
    const w = windowOf(windowMinutes, now);
    const params = new Params();
    const where = [
      `minute >= ${params.add(new Date(w.first * MINUTE_MS))}`,
      `minute <= ${params.add(new Date(w.last * MINUTE_MS))}`,
    ];
    if (service !== undefined) {
      where.push(`service_name = ${params.add(service)}`);
    }
    const rows = await this.rows<{
      class_name: string;
      method_name: string;
      class_kind: string;
      count: number;
      errors: number;
      total_ms: number;
      max_ms: number;
    }>(
      `SELECT class_name, method_name, class_kind, count, errors, total_ms, max_ms
         FROM class_minutes WHERE ${where.join(" AND ")}`,
      params.values,
    );

    // Own time per call, from the stored method spans started in the window.
    const own = new Map<string, Map<string, number>>();
    if (rows.length > 0) {
      const p = new Params();
      const spanWhere = [
        "s.class_name IS NOT NULL",
        `s.start_time >= ${p.add(new Date(w.fromMs))}`,
      ];
      if (ownUntilMs !== undefined) {
        spanWhere.push(`s.start_time <= ${p.add(new Date(ownUntilMs))}`);
      }
      if (service !== undefined) {
        spanWhere.push(`s.service_name = ${p.add(service)}`);
      }
      const skewFrom = p.add(new Date(w.fromMs - SKEW_MS));
      const ownRows = await this.rows<{
        class_name: string;
        method_name: string;
        own_avg_ms: number;
      }>(
        // One pass (the window's method spans once, their children summed once per parent). A
        // child may start before its parent (another host's clock): children are bounded by the
        // window start less a minute of skew, which still lets Postgres skip older partitions.
        `WITH win AS (
           SELECT s.trace_id, s.span_id, s.class_name, s.method_name, s.duration_ns
             FROM spans s
            WHERE ${spanWhere.join(" AND ")}
         ), kids AS (
           SELECT c.trace_id, c.parent_span_id, sum(c.duration_ns) AS child_ns
             FROM spans c
            WHERE c.trace_id IN (SELECT trace_id FROM win)
              AND c.parent_span_id IS NOT NULL
              AND c.start_time >= ${skewFrom}
            GROUP BY c.trace_id, c.parent_span_id
         )
         SELECT s.class_name, s.method_name,
                avg(greatest(0, s.duration_ns - coalesce(ch.child_ns, 0)))::float8 / 1e6 AS own_avg_ms
           FROM win s
           LEFT JOIN kids ch ON ch.trace_id = s.trace_id AND ch.parent_span_id = s.span_id
          GROUP BY s.class_name, s.method_name`,
        p.values,
      );
      for (const r of ownRows) {
        let byMethod = own.get(r.class_name);
        if (byMethod === undefined) {
          byMethod = new Map();
          own.set(r.class_name, byMethod);
        }
        byMethod.set(r.method_name, Number(r.own_avg_ms));
      }
    }

    interface MethodAcc {
      calls: number;
      errors: number;
      totalMs: number;
      maxMs: number;
    }
    interface ClassAcc {
      kinds: Map<string, number>;
      methods: Map<string, MethodAcc>;
    }
    const byClass = new Map<string, ClassAcc>();
    for (const r of rows) {
      let c = byClass.get(r.class_name);
      if (c === undefined) {
        c = { kinds: new Map(), methods: new Map() };
        byClass.set(r.class_name, c);
      }
      c.kinds.set(r.class_kind, (c.kinds.get(r.class_kind) ?? 0) + r.count);
      let m = c.methods.get(r.method_name);
      if (m === undefined) {
        m = { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
        c.methods.set(r.method_name, m);
      }
      m.calls += r.count;
      m.errors += r.errors;
      m.totalMs += r.total_ms;
      if (r.max_ms > m.maxMs) m.maxMs = r.max_ms;
    }
    const classes: ClassStats[] = [];
    for (const [className, c] of byClass) {
      const methods: MethodStats[] = [];
      let calls = 0;
      let errors = 0;
      let totalMs = 0;
      let ownMs: number | null = null;
      for (const [method, m] of c.methods) {
        if (m.calls === 0) continue;
        const ownAvg = own.get(className)?.get(method) ?? null;
        methods.push({
          method,
          calls: m.calls,
          errors: m.errors,
          totalMs: round(m.totalMs),
          avgMs: round(m.totalMs / m.calls),
          maxMs: round(m.maxMs),
          ownAvgMs: ownAvg === null ? null : round(ownAvg),
        });
        calls += m.calls;
        errors += m.errors;
        totalMs += m.totalMs;
        if (ownAvg !== null) ownMs = (ownMs ?? 0) + ownAvg * m.calls;
      }
      if (calls === 0) continue;
      methods.sort(
        (a, b) =>
          b.totalMs - a.totalMs ||
          (a.method < b.method ? -1 : a.method > b.method ? 1 : 0),
      );
      let kind = "provider";
      let best = -1;
      for (const [k, n] of c.kinds) {
        if (n > best && CLASS_KINDS.has(k)) {
          kind = k;
          best = n;
        }
      }
      classes.push({
        className,
        kind: kind as ClassKind,
        calls,
        errors,
        totalMs: round(totalMs),
        avgMs: round(totalMs / calls),
        ownMs: ownMs === null ? null : round(ownMs),
        methods,
      });
    }
    classes.sort(
      (a, b) =>
        b.totalMs - a.totalMs ||
        (a.className < b.className ? -1 : a.className > b.className ? 1 : 0),
    );
    // "off" only when no method span was ever kept (for this service, or for any service when
    // unfiltered); data older than the window is "no-data-in-range", not "off". Partitions are
    // dropped by retention, so the unbounded EXISTS is bounded by it.
    let methodsState: ClassStatsResponse["methodsState"] = "on";
    if (rows.length === 0) {
      const p = new Params();
      const any = await this.rows<{ found: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM class_minutes${
          service === undefined ? "" : ` WHERE service_name = ${p.add(service)}`
        }) AS found`,
        p.values,
      );
      methodsState = any[0]?.found === true ? "no-data-in-range" : "off";
    }
    return {
      windowMinutes,
      fromUnixMs: w.fromMs,
      toUnixMs: now,
      methodsEnabled: methodsState !== "off",
      methodsState,
      classes,
    };
  }

  // ---- timeline and dependencies (P9-05) ------------------------------------------------------

  /** Sampled traces per bucket by outcome of their root; the trace list's filters apply. */
  async timeline(v: Values): Promise<TraceTimelineResponse> {
    const windowMinutes = v.windowMinutes as number;
    const bucketMs = bucketMsFor(windowMinutes);
    const count = (windowMinutes * MINUTE_MS) / bucketMs;
    const now = Date.now();
    const first = Math.floor(now / bucketMs) - count + 1;
    const params = new Params();
    const where = this.traceWhere(v, params);
    where.push(`start_time >= ${params.add(new Date(first * bucketMs))}`);
    where.push(`start_time <= ${params.add(new Date(now))}`);
    const rows = await this.rows<{
      b: string;
      ok: number;
      client_error: number;
      server_error: number;
    }>(
      `SELECT floor(extract(epoch FROM start_time) * 1000 / ${bucketMs})::bigint AS b,
              count(*) FILTER (WHERE NOT is_error AND coalesce(http_status, 0) < 400)::int AS ok,
              count(*) FILTER (WHERE NOT is_error AND http_status BETWEEN 400 AND 499)::int AS client_error,
              count(*) FILTER (WHERE is_error OR coalesce(http_status, 0) >= 500)::int AS server_error
         FROM traces
        WHERE ${where.join(" AND ")}
        GROUP BY b`,
      params.values,
    );
    const buckets = Array.from({ length: count }, (_, i) => ({
      startUnixMs: (first + i) * bucketMs,
      ok: 0,
      clientError: 0,
      serverError: 0,
    }));
    for (const r of rows) {
      const bucket = buckets[Number(r.b) - first];
      if (bucket === undefined) continue;
      bucket.ok += Number(r.ok);
      bucket.clientError += Number(r.client_error);
      bucket.serverError += Number(r.server_error);
    }
    return {
      windowMinutes,
      fromUnixMs: first * bucketMs,
      toUnixMs: now,
      bucketMs,
      buckets,
    };
  }

  /**
   * Outbound targets (the map's rule: client and producer spans that do not call into another
   * service) with totals and a per-bucket series, from the stored spans.
   */
  async dependencies(
    windowMinutes: number,
    service: string | undefined,
    now: number = Date.now(),
  ): Promise<DependenciesResponse> {
    const bucketMs = bucketMsFor(windowMinutes);
    const count = (windowMinutes * MINUTE_MS) / bucketMs;
    const first = Math.floor(now / bucketMs) - count + 1;
    const from = new Date(first * bucketMs);
    const to = new Date(now);
    const t = new Params();
    const fromParam = t.add(from);
    const toParam = t.add(to);
    const where = [
      "s.kind IN ('client', 'producer')",
      `s.start_time >= ${fromParam}`,
      `s.start_time <= ${toParam}`,
      `NOT EXISTS (SELECT 1 FROM spans c
                   WHERE c.trace_id = s.trace_id AND c.parent_span_id = s.span_id
                     AND c.kind IN ('server', 'consumer') AND c.service_name <> s.service_name
                     AND c.start_time >= ${fromParam}::timestamptz - interval '${SKEW_MS / 1000} seconds'
                     AND c.start_time <= ${toParam}::timestamptz + interval '${SKEW_MS / 1000} seconds')`,
    ];
    if (service !== undefined) where.push(`s.service_name = ${t.add(service)}`);
    const attributes = TARGET_KEYS.map((key) =>
      key === "url.full"
        ? `'url.full', to_jsonb(substring(s.attributes->>'url.full' from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*'))`
        : `'${key}', s.attributes->'${key}'`,
    ).join(", ");
    const rows = await this.rows<Record<string, unknown>>(
      `SELECT floor(extract(epoch FROM s.start_time) * 1000 / ${bucketMs})::bigint AS b,
              jsonb_strip_nulls(jsonb_build_object(${attributes})) AS a,
              count(*)::int AS calls,
              count(*) FILTER (WHERE s.status_code = 'error')::int AS errors,
              sum(s.duration_ns)::text AS sum_ns,
              max(s.duration_ns)::text AS max_ns,
              (array_agg(s.trace_id ORDER BY s.duration_ns DESC))[1] AS example,
              ${histogramColumns("s.duration_ns")}
         FROM spans s
        WHERE ${where.join(" AND ")}
        GROUP BY b, a`,
      t.values,
    );

    interface Part {
      calls: number;
      maxMs: number;
      hist: number[];
    }
    interface Acc extends Part {
      node: MapNode;
      errors: number;
      totalMs: number;
      example: string | undefined;
      perBucket: Part[];
    }
    const targets = new Map<string, Acc>();
    for (const r of rows) {
      const node = targetOf(r.a as Record<string, unknown>);
      let acc = targets.get(node.id);
      if (acc === undefined) {
        acc = {
          node,
          calls: 0,
          errors: 0,
          totalMs: 0,
          maxMs: -1,
          hist: emptyHistogram(),
          example: undefined,
          perBucket: Array.from({ length: count }, () => ({
            calls: 0,
            maxMs: 0,
            hist: emptyHistogram(),
          })),
        };
        targets.set(node.id, acc);
      }
      const calls = Number(r.calls);
      const maxMs = msOf(String(r.max_ns));
      const hist = histogramOf(r);
      acc.calls += calls;
      acc.errors += Number(r.errors);
      acc.totalMs += msOf(String(r.sum_ns));
      if (maxMs > acc.maxMs) {
        acc.maxMs = maxMs;
        acc.example = typeof r.example === "string" ? r.example : undefined;
      }
      addHistograms(acc.hist, hist);
      const bucket = acc.perBucket[Number(r.b) - first];
      if (bucket !== undefined) {
        bucket.calls += calls;
        bucket.maxMs = Math.max(bucket.maxMs, maxMs);
        addHistograms(bucket.hist, hist);
      }
    }
    const dependencies: DependencyStats[] = [...targets.values()]
      .sort((a, b) => b.totalMs - a.totalMs || (a.node.id < b.node.id ? -1 : 1))
      .slice(0, MAX_DEPENDENCIES)
      .map((acc) => {
        const item: DependencyStats = {
          id: acc.node.id,
          kind: acc.node.kind,
          name: acc.node.name,
          calls: acc.calls,
          errors: acc.errors,
          errorRate: acc.calls === 0 ? 0 : acc.errors / acc.calls,
          totalMs: round(acc.totalMs),
          p50Ms: estimateQuantile(acc.hist, acc.calls, 0.5, acc.maxMs),
          p95Ms: estimateQuantile(acc.hist, acc.calls, 0.95, acc.maxMs),
          series: acc.perBucket.map((p, i) => ({
            startUnixMs: (first + i) * bucketMs,
            calls: p.calls,
            p95Ms:
              p.calls === 0
                ? 0
                : estimateQuantile(p.hist, p.calls, 0.95, p.maxMs),
          })),
        };
        if (acc.node.system !== undefined) item.system = acc.node.system;
        if (acc.example !== undefined) item.exampleTraceId = acc.example;
        return item;
      });
    return {
      windowMinutes,
      fromUnixMs: first * bucketMs,
      toUnixMs: now,
      bucketMs,
      dependencies,
    };
  }

  // ---- map -------------------------------------------------------------------------------------

  /** Statements across the stored, sampled traces of the window (P9-03). */
  async queries(
    windowMinutes: number,
    service: string | undefined,
    sort: QuerySort,
    limit: number,
    now: number = Date.now(),
  ): Promise<QueryStatsResponse> {
    const w = windowOf(windowMinutes, now);
    const { text, values } = queriesSql({
      from: new Date(w.fromMs),
      to: new Date(now),
      service,
      sort,
      limit,
    });
    const rows = await this.rows<{
      stmt: string;
      sys: string;
      n: number;
      total_ns: number;
      max_ns: number;
      p95_ns: number;
      errors: number;
      traces: number;
      repeated: number;
      examples: string[];
    }>(text, values);
    return {
      windowMinutes,
      fromUnixMs: w.fromMs,
      toUnixMs: now,
      sampled: true,
      truncated: false,
      queries: rows.map((r) => ({
        statement: r.stmt,
        system: r.sys,
        kind: CACHE_SYSTEMS.has(r.sys.toLowerCase()) ? "cache" : "database",
        count: Number(r.n),
        totalMs: Number(r.total_ns) / 1e6,
        avgMs: Number(r.total_ns) / 1e6 / Math.max(1, Number(r.n)),
        p95Ms: Number(r.p95_ns) / 1e6,
        maxMs: Number(r.max_ns) / 1e6,
        errors: Number(r.errors),
        traces: Number(r.traces),
        repeatedTraces: Number(r.repeated),
        exampleTraceIds: r.examples,
      })),
    };
  }

  async map(
    windowMinutes: number,
    service: string | undefined,
    now: number = Date.now(),
  ): Promise<AppMapResponse> {
    const w = windowOf(windowMinutes, now);
    const from = new Date(w.fromMs);
    const to = new Date(now);

    // External targets: client and producer spans that do not call into another service.
    const t = new Params();
    const fromParam = t.add(from);
    const toParam = t.add(to);
    const targetWhere = [
      "s.kind IN ('client', 'producer')",
      `s.start_time >= ${fromParam}`,
      `s.start_time <= ${toParam}`,
      `NOT EXISTS (SELECT 1 FROM spans c
                   WHERE c.trace_id = s.trace_id AND c.parent_span_id = s.span_id
                     AND c.kind IN ('server', 'consumer') AND c.service_name <> s.service_name
                     AND c.start_time >= ${fromParam}::timestamptz - interval '${SKEW_MS / 1000} seconds'
                     AND c.start_time <= ${toParam}::timestamptz + interval '${SKEW_MS / 1000} seconds')`,
    ];
    if (service !== undefined) {
      targetWhere.push(`s.service_name = ${t.add(service)}`);
    }
    const attributes = TARGET_KEYS.map((key) =>
      key === "url.full"
        ? `'url.full', to_jsonb(substring(s.attributes->>'url.full' from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*'))`
        : `'${key}', s.attributes->'${key}'`,
    ).join(", ");
    const targetRows = await this.rows<Record<string, unknown>>(
      `SELECT s.service_name, jsonb_strip_nulls(jsonb_build_object(${attributes})) AS a,
              count(*)::int AS calls,
              count(*) FILTER (WHERE s.status_code = 'error')::int AS errors,
              max(s.duration_ns)::text AS max_ns,
              ${histogramColumns("s.duration_ns")}
         FROM spans s
        WHERE ${targetWhere.join(" AND ")}
        GROUP BY s.service_name, a`,
      t.values,
    );

    // Service to service: a client or producer span whose child server or consumer span is in
    // another service.
    const e = new Params();
    const eFrom = e.add(from);
    const eTo = e.add(to);
    const edgeWhere = [
      "p.kind IN ('client', 'producer')",
      "c.kind IN ('server', 'consumer')",
      "c.service_name <> p.service_name",
      `p.start_time >= ${eFrom}`,
      `p.start_time <= ${eTo}`,
      `c.start_time >= ${eFrom}::timestamptz - interval '${SKEW_MS / 1000} seconds'`,
      `c.start_time <= ${eTo}::timestamptz + interval '${SKEW_MS / 1000} seconds'`,
    ];
    if (service !== undefined) {
      const name = e.add(service);
      edgeWhere.push(`(p.service_name = ${name} OR c.service_name = ${name})`);
    }
    const edgeRows = await this.rows<Record<string, unknown>>(
      `SELECT p.service_name AS from_service, c.service_name AS to_service,
              count(*)::int AS calls,
              count(*) FILTER (WHERE p.status_code = 'error')::int AS errors,
              max(p.duration_ns)::text AS max_ns,
              ${histogramColumns("p.duration_ns")}
         FROM spans p
         JOIN spans c ON c.trace_id = p.trace_id AND c.parent_span_id = p.span_id
        WHERE ${edgeWhere.join(" AND ")}
        GROUP BY p.service_name, c.service_name`,
      e.values,
    );

    // Service nodes: services seen in the window, plus both ends of every edge.
    const s = new Params();
    const seenWhere = [`last_seen >= ${s.add(new Date(w.fromMs - SKEW_MS))}`];
    if (service !== undefined) seenWhere.push(`name = ${s.add(service)}`);
    const seen = await this.rows<{ name: string }>(
      `SELECT name FROM services WHERE ${seenWhere.join(" AND ")}`,
      s.values,
    );
    const serviceNames = new Set(seen.map((r) => r.name));
    for (const r of targetRows) serviceNames.add(String(r.service_name));
    for (const r of edgeRows) {
      serviceNames.add(String(r.from_service));
      serviceNames.add(String(r.to_service));
    }
    const serviceId = (name: string) => `service:${name}`;

    // Merge target rows per (service, target node).
    interface Acc {
      from: string;
      node: MapNode;
      calls: number;
      errors: number;
      maxMs: number;
      hist: number[];
    }
    const accumulate = (
      into: Map<string, Acc>,
      key: string,
      init: () => Acc,
      row: Record<string, unknown>,
    ) => {
      let acc = into.get(key);
      if (acc === undefined) {
        acc = init();
        into.set(key, acc);
      }
      acc.calls += Number(row.calls);
      acc.errors += Number(row.errors);
      acc.maxMs = Math.max(acc.maxMs, msOf(String(row.max_ns)));
      addHistograms(acc.hist, histogramOf(row));
    };
    const targets = new Map<string, Acc>();
    for (const r of targetRows) {
      const node = targetOf(r.a as Record<string, unknown>);
      const from = serviceId(String(r.service_name));
      accumulate(
        targets,
        `${from}\u0000${node.id}`,
        () => ({
          from,
          node,
          calls: 0,
          errors: 0,
          maxMs: 0,
          hist: emptyHistogram(),
        }),
        r,
      );
    }
    // Fold the least-called targets into one node when there are too many.
    const totals = new Map<string, number>();
    for (const acc of targets.values()) {
      totals.set(acc.node.id, (totals.get(acc.node.id) ?? 0) + acc.calls);
    }
    const room = Math.max(1, MAX_MAP_NODES - serviceNames.size);
    let folded = new Set<string>();
    if (totals.size > room) {
      const ranked = [...totals.entries()].sort(
        (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
      );
      folded = new Set(ranked.slice(room - 1).map(([id]) => id));
    }
    const edgeAccs = new Map<string, Acc>();
    const nodes = new Map<string, MapNode>();
    const overflow: MapNode = {
      id: OVERFLOW_ID,
      kind: "other",
      name: "other (more targets)",
    };
    for (const acc of targets.values()) {
      const node = folded.has(acc.node.id) ? overflow : acc.node;
      nodes.set(node.id, node);
      const key = `${acc.from}\u0000${node.id}`;
      let merged = edgeAccs.get(key);
      if (merged === undefined) {
        merged = {
          ...acc,
          node,
          hist: emptyHistogram(),
          calls: 0,
          errors: 0,
          maxMs: 0,
        };
        edgeAccs.set(key, merged);
      }
      merged.calls += acc.calls;
      merged.errors += acc.errors;
      merged.maxMs = Math.max(merged.maxMs, acc.maxMs);
      addHistograms(merged.hist, acc.hist);
    }
    const edges: MapEdge[] = [];
    for (const acc of edgeAccs.values()) {
      edges.push({
        from: acc.from,
        to: acc.node.id,
        calls: acc.calls,
        errors: acc.errors,
        p50Ms: estimateQuantile(acc.hist, acc.calls, 0.5, acc.maxMs),
        p95Ms: estimateQuantile(acc.hist, acc.calls, 0.95, acc.maxMs),
      });
    }
    for (const r of edgeRows) {
      const hist = histogramOf(r);
      const calls = Number(r.calls);
      const maxMs = msOf(String(r.max_ns));
      edges.push({
        from: serviceId(String(r.from_service)),
        to: serviceId(String(r.to_service)),
        calls,
        errors: Number(r.errors),
        p50Ms: estimateQuantile(hist, calls, 0.5, maxMs),
        p95Ms: estimateQuantile(hist, calls, 0.95, maxMs),
      });
    }
    edges.sort(
      (a, b) =>
        b.calls - a.calls ||
        (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
        (a.to < b.to ? -1 : a.to > b.to ? 1 : 0),
    );
    const serviceNodes: MapNode[] = [...serviceNames]
      .sort()
      .map((name) => ({ id: serviceId(name), kind: "app", name }));
    const targetNodes = [...nodes.values()].sort((a, b) => {
      const byCalls = (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0);
      return byCalls || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    return {
      windowMinutes,
      fromUnixMs: w.fromMs,
      toUnixMs: now,
      nodes: [...serviceNodes, ...targetNodes],
      edges,
    };
  }
}

interface ErrorRow {
  trace_id: string;
  span_id: string;
  name: string;
  kind: SpanKind;
  status_message: string | null;
  events: { name: string; timeUnixNano: string; attributes: Attributes }[];
  start_ns: string;
  end_ns: string;
  http_route: string | null;
  http_method: string | null;
  http_status: number | null;
  ts: string;
}

function errorItemOf(
  r: ErrorRow,
  root:
    | {
        http_route: string | null;
        http_method: string | null;
        http_status: number | null;
      }
    | undefined,
): ErrorItem {
  const exception = r.events.find((e) => e.name === "exception");
  const item: ErrorItem = {
    traceId: r.trace_id,
    spanId: r.span_id,
    spanName: r.name,
    spanKind: r.kind,
    timeUnixMs: exception ? msOf(exception.timeUnixNano) : msOf(r.end_ns),
    cursor: errorCursor(r),
  };
  // The trace's root once known; the span itself otherwise.
  const source = root ?? r;
  if (source.http_route !== null) item.route = source.http_route;
  if (source.http_method !== null) item.method = source.http_method;
  if (source.http_status !== null) item.statusCode = source.http_status;
  const type = exception?.attributes["exception.type"];
  const message = exception?.attributes["exception.message"];
  const errorType = typeof type === "string" ? type : r.status_message;
  if (errorType !== null) item.errorType = errorType;
  const text = typeof message === "string" ? message : r.status_message;
  if (text !== null) item.message = text;
  return item;
}
