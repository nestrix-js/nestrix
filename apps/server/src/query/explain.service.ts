/**
 * `GET /api/v1/routes/explain` (phase 12, P12-01): gathers the sampled traces of one route for
 * the two sides (the `traces` table by route, method, time or release) and their spans, classifies
 * the spans with the same rules as the overview, Queries and Dependencies queries, and calls the
 * shared computation (`explain-compute.ts`, a byte-identical copy of the embedded dashboard's).
 * At most the newest 2,000 traces per side are read.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { RouteExplainResponse } from "@nestrix-js/protocol";
import type pg from "pg";
import { STORAGE_POOL } from "../storage/storage.module.js";
import {
  computeExplain,
  type ExplainSideInput,
  type ExplainSpanInput,
  type ExplainTraceInput,
  MAX_TRACES_PER_SIDE,
} from "./explain-compute.js";
import { timeKeyOf } from "./overview-compute.js";
import { TARGET_KEYS, targetOf } from "./targets.js";

const MINUTE_MS = 60_000;
const MAX_RELEASES = 20;

const DEPENDENCY_KIND: Record<string, "http" | "db" | "redis" | "messaging"> = {
  http: "http",
  database: "db",
  cache: "redis",
  queue: "messaging",
};

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export interface ExplainRequest {
  method: string | undefined;
  route: string;
  windowMinutes: number;
  releaseA: string | undefined;
  releaseB: string | undefined;
  service: string | undefined;
}

interface RouteFilter {
  method: string | undefined;
  route: string;
  service: string | undefined;
}

interface TraceSqlRow {
  trace_id: string;
  start_ms: number | string;
  duration_ms: number | string;
  http_status: number | null;
  is_error: boolean;
}

interface SpanSqlRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  service_name: string;
  kind: string;
  status_code: string;
  duration_ms: number | string;
  class_name: string | null;
  method_name: string | null;
  has_component: boolean;
  a: Record<string, unknown>;
  exceptions: { type?: unknown; message?: unknown }[];
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

@Injectable()
export class ExplainService {
  constructor(@Inject(STORAGE_POOL) private readonly pool: pg.Pool) {}

  private async rows<T>(
    text: string,
    params: readonly unknown[],
  ): Promise<T[]> {
    const result = await this.pool.query(text, params as unknown[]);
    return result.rows as T[];
  }

  async explain(
    req: ExplainRequest,
    now: number = Date.now(),
  ): Promise<RouteExplainResponse> {
    const method = req.method?.toUpperCase();
    const releaseMode =
      req.releaseA !== undefined && req.releaseB !== undefined;
    const last = Math.floor(now / MINUTE_MS);
    const curFirst = last - req.windowMinutes + 1;
    const curFromMs = curFirst * MINUTE_MS;
    const prevFromMs = (curFirst - req.windowMinutes) * MINUTE_MS;

    const filter: RouteFilter = {
      method,
      route: req.route,
      service: req.service,
    };
    const [beforeRows, afterRows, releases] = await Promise.all([
      releaseMode
        ? this.traces(filter, { release: req.releaseA as string })
        : this.traces(filter, { fromMs: prevFromMs, beforeMs: curFromMs }),
      releaseMode
        ? this.traces(filter, { release: req.releaseB as string })
        : this.traces(filter, { fromMs: curFromMs, toMs: now }),
      this.releases(filter),
    ]);
    const spans = await this.spans([...beforeRows, ...afterRows]);
    const side = (
      label: string,
      from: number,
      to: number,
      rows: TraceSqlRow[],
    ): ExplainSideInput => {
      const traces = rows.map((r) =>
        traceInput(r, spans.get(r.trace_id) ?? []),
      );
      if (!releaseMode)
        return { label, fromUnixMs: from, toUnixMs: to, traces };
      let first = Number.POSITIVE_INFINITY;
      let lastAt = 0;
      for (const t of traces) {
        first = Math.min(first, t.startUnixMs);
        lastAt = Math.max(lastAt, t.startUnixMs);
      }
      return {
        label,
        fromUnixMs: Number.isFinite(first) ? first : 0,
        toUnixMs: lastAt,
        traces,
      };
    };
    return computeExplain({
      mode: releaseMode ? "release" : "window",
      method: method ?? null,
      route: req.route,
      before: side(
        releaseMode ? (req.releaseA as string) : "previous",
        prevFromMs,
        curFromMs,
        beforeRows,
      ),
      after: side(
        releaseMode ? (req.releaseB as string) : "current",
        curFromMs,
        now,
        afterRows,
      ),
      releases,
    });
  }

  /** The newest traces of the route in one side's range or release. */
  private async traces(
    filter: RouteFilter,
    side: {
      fromMs?: number;
      beforeMs?: number;
      toMs?: number;
      release?: string;
    },
  ): Promise<TraceSqlRow[]> {
    const p = new Params();
    const where = [`http_route = ${p.add(filter.route)}`];
    if (filter.method !== undefined) {
      where.push(`http_method = ${p.add(filter.method)}`);
    }
    if (filter.service !== undefined) {
      where.push(`service_name = ${p.add(filter.service)}`);
    }
    if (side.release !== undefined) {
      where.push(`release = ${p.add(side.release)}`);
    }
    if (side.fromMs !== undefined) {
      where.push(`start_time >= ${p.add(new Date(side.fromMs))}`);
    }
    if (side.beforeMs !== undefined) {
      where.push(`start_time < ${p.add(new Date(side.beforeMs))}`);
    }
    if (side.toMs !== undefined) {
      where.push(`start_time <= ${p.add(new Date(side.toMs))}`);
    }
    return this.rows<TraceSqlRow>(
      `SELECT trace_id, (extract(epoch FROM start_time) * 1000)::float8 AS start_ms,
              (duration_ns::float8 / 1e6) AS duration_ms, http_status, is_error
         FROM traces WHERE ${where.join(" AND ")}
        ORDER BY start_time DESC LIMIT ${MAX_TRACES_PER_SIDE}`,
      p.values,
    );
  }

  /** Releases with stored traces of the route, most recent trace first. */
  private async releases(filter: RouteFilter): Promise<string[]> {
    const p = new Params();
    const where = [
      `http_route = ${p.add(filter.route)}`,
      "release IS NOT NULL",
    ];
    if (filter.method !== undefined) {
      where.push(`http_method = ${p.add(filter.method)}`);
    }
    if (filter.service !== undefined) {
      where.push(`service_name = ${p.add(filter.service)}`);
    }
    const rows = await this.rows<{ release: string }>(
      `SELECT release FROM traces WHERE ${where.join(" AND ")}
        GROUP BY release ORDER BY max(start_time) DESC, release LIMIT ${MAX_RELEASES}`,
      p.values,
    );
    return rows.map((r) => r.release);
  }

  /** The spans of the given traces, by trace id, as the computation wants them. */
  private async spans(
    traces: readonly TraceSqlRow[],
  ): Promise<Map<string, ExplainSpanInput[]>> {
    const out = new Map<string, ExplainSpanInput[]>();
    if (traces.length === 0) return out;
    const earliest = traces.reduce(
      (m, t) => Math.min(m, Number(t.start_ms)),
      Number.POSITIVE_INFINITY,
    );
    const p = new Params();
    const ids = p.add(traces.map((t) => t.trace_id));
    // Spans start no earlier than the earliest root (less a minute of clock skew); the bound lets
    // Postgres skip older partitions.
    const from = p.add(new Date(earliest - MINUTE_MS));
    const keys = [...TARGET_KEYS, "db.query.text"]
      .map((key) =>
        key === "url.full"
          ? `'url.full', to_jsonb(substring(s.attributes->>'url.full' from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*'))`
          : `'${key}', s.attributes->'${key}'`,
      )
      .join(", ");
    const rows = await this.rows<SpanSqlRow>(
      `SELECT s.trace_id, s.span_id, s.parent_span_id, s.service_name, s.kind, s.status_code,
              (s.duration_ns::float8 / 1e6) AS duration_ms, s.class_name, s.method_name,
              (s.attributes ? 'nestrix.component') AS has_component,
              jsonb_strip_nulls(jsonb_build_object(${keys})) AS a,
              (SELECT coalesce(jsonb_agg(jsonb_build_object(
                        'type', e->'attributes'->'exception.type',
                        'message', to_jsonb(left(e->'attributes'->>'exception.message', 300)))),
                      '[]'::jsonb)
                 FROM jsonb_array_elements(s.events) e WHERE e->>'name' = 'exception') AS exceptions
         FROM spans s
        WHERE s.trace_id = ANY(${ids}) AND s.start_time >= ${from}`,
      p.values,
    );
    const byTrace = new Map<string, SpanSqlRow[]>();
    for (const r of rows) {
      const list = byTrace.get(r.trace_id);
      if (list === undefined) byTrace.set(r.trace_id, [r]);
      else list.push(r);
    }
    for (const [traceId, list] of byTrace) {
      // Spans whose child is a server or consumer span of another service: calls into a service.
      const byId = new Map(list.map((r) => [r.span_id, r]));
      const intoService = new Set<string>();
      for (const c of list) {
        if (c.kind !== "server" && c.kind !== "consumer") continue;
        if (c.parent_span_id === null) continue;
        const parent = byId.get(c.parent_span_id);
        if (parent !== undefined && parent.service_name !== c.service_name) {
          intoService.add(parent.span_id);
        }
      }
      out.set(
        traceId,
        list.map((r) => spanInput(r, intoService.has(r.span_id))),
      );
    }
    return out;
  }
}

function traceInput(
  r: TraceSqlRow,
  spans: ExplainSpanInput[],
): ExplainTraceInput {
  return {
    traceId: r.trace_id,
    startUnixMs: Number(r.start_ms),
    durationMs: Number(r.duration_ms),
    status: r.http_status,
    error: r.is_error || (r.http_status !== null && r.http_status >= 500),
    spans,
  };
}

function spanInput(r: SpanSqlRow, intoService: boolean): ExplainSpanInput {
  const a = r.a ?? {};
  const system = str(a["db.system.name"]) ?? str(a["db.system"]);
  const dbSystem = system?.toLowerCase();
  const out: ExplainSpanInput = {
    spanId: r.span_id,
    durationMs: Number(r.duration_ms),
    error: r.status_code === "error",
    key: timeKeyOf({
      kind: r.kind,
      dbSystem,
      messaging: str(a["messaging.system"]) !== undefined,
      http:
        str(a["http.request.method"]) !== undefined ||
        str(a["http.method"]) !== undefined ||
        str(a["url.full"]) !== undefined,
      nest: r.class_name !== null || r.has_component,
    }),
    exceptions: (r.exceptions ?? []).map((e) => ({
      ...(typeof e.type === "string" ? { type: e.type } : {}),
      ...(typeof e.message === "string" ? { message: e.message } : {}),
    })),
  };
  if (r.parent_span_id !== null) out.parentSpanId = r.parent_span_id;
  const text = str(a["db.query.text"]);
  if (r.kind === "client" && text !== undefined && system !== undefined) {
    out.statement = { statement: text, system };
  }
  if (r.class_name !== null && r.method_name !== null) {
    out.method = `${r.class_name}.${r.method_name}`;
  }
  if ((r.kind === "client" || r.kind === "producer") && !intoService) {
    const node = targetOf(a);
    const kind = DEPENDENCY_KIND[node.kind];
    if (kind !== undefined) out.dependency = { name: node.name, kind };
  }
  return out;
}
