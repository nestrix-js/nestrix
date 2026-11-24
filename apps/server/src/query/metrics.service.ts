/**
 * `GET /api/v1/metrics/catalog` and `GET /api/v1/metrics/series` (issue #18, D-105): the historical
 * runtime metrics of `metric_minutes` (`storage/metrics.ts`). The arithmetic is described in
 * `@nestrix-js/protocol`'s `metrics.ts`.
 *
 * - counters and gauges are computed in SQL (window functions over consecutive minutes, then
 *   grouped per bucket, per instance, and across instances), so a response never holds more than
 *   buckets x 20 rows;
 * - histograms are computed here from the rows (bucket increases need array arithmetic); at most
 *   `MAX_HISTOGRAM_ROWS` rows are read, more is a `400` asking for a narrower range.
 * - a counter or histogram row whose predecessor is more than `MAX_GAP_SECONDS` older is not used:
 *   a gap is `null`, never an average over the silence. A delta row counts as one minute.
 * - application metrics (issue #87, D-118, `NESTRIX_METRICS=all`): rows with a `unit` (the catalog's
 *   have none). A name is served with the type and unit of its newest row in the scope; rows of that
 *   name stored with another type or unit are left out. The series of one instance are added.
 * - grouping: every statement carries a group column `g` (`''`, the instance, or an attribute's
 *   value), so `by=instance` and `by=attr.<key>` are the same arithmetic per group.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
  MetricAggregation,
  MetricCatalogResponse,
  MetricDefinition,
  MetricInstance,
  MetricSeries,
  MetricSeriesResponse,
} from "@nestrix-js/protocol";
import type pg from "pg";
import type { ServerConfig } from "../config.js";
import { SERVER_CONFIG } from "../config.module.js";
import {
  type CatalogEntry,
  type CatalogKind,
  catalogEntry,
  METRIC_CATALOG,
} from "../metrics/catalog.js";
import { STORAGE_POOL } from "../storage/storage.module.js";
import { PostgresIngestSink } from "../storage/writer.js";
import { adder, type Scope, scopeSql } from "./scope.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
export const MAX_BUCKETS = 1_440;
const TARGET_BUCKETS = 360;
const MAX_INSTANCE_SERIES = 20;
const MAX_INSTANCES_LISTED = 200;
const MAX_GAP_SECONDS = 600;
const MAX_HISTOGRAM_ROWS = 300_000;

/** A request the service refuses; the controller makes it a `400`. */
export class MetricsParamError extends Error {}

export interface SeriesQuery {
  metric: string;
  service?: string;
  /** Issue #28 (D-101): absent every environment, `unset` the rows without one. */
  environment?: string;
  instance?: string;
  fromUnixMs?: number;
  toUnixMs?: number;
  stepMs?: number;
  aggregation?: MetricAggregation;
  /** `instance`, or (D-118) `attr.<key>`. */
  by?: string;
  /** D-118: `attr.<key>=<value>` filters, every one must match. */
  attributes?: ReadonlyArray<readonly [string, string]>;
}

export interface CatalogQuery {
  service?: string;
  /** Issue #28 (D-101): as `SeriesQuery.environment`. */
  environment?: string;
  fromUnixMs?: number;
  toUnixMs?: number;
}

function definition(e: CatalogEntry): MetricDefinition {
  return {
    name: e.name,
    kind: e.kind,
    unit: e.unit,
    valueUnit: e.kind === "counter" ? counterUnit(e.unit) : e.unit,
    description: e.description,
    defaultAggregation: e.kind === "counter" ? "sum" : "avg",
  };
}

/** At most this many application metrics are listed (D-118), most recently seen first. */
const MAX_APP_METRICS_LISTED = 1_000;
/** Attribute keys listed per application metric (D-118). */
const MAX_APP_ATTRIBUTE_KEYS_LISTED = 64;

/** D-118: an application metric as stored. Its series of one instance add up (`merge: "sum"`). */
function appEntry(name: string, kind: CatalogKind, unit: string): CatalogEntry {
  return {
    name,
    kind,
    unit,
    description: "",
    attributes: [],
    merge: "sum",
  };
}

/** D-118: per second of a counter; a dimensionless count (`""`, `1`) is `1/s`. */
function counterUnit(unit: string): string {
  return unit === "" || unit === "1" ? "1/s" : `${unit}/s`;
}

/** Quantile `q` of per-bucket counts by linear interpolation inside the bucket. */
export function histogramQuantile(
  bounds: readonly number[],
  counts: readonly number[],
  q: number,
): number | null {
  let total = 0;
  for (const c of counts) total += c;
  if (!(total > 0)) return null;
  const rank = q * total;
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i] ?? 0;
    if (c > 0 && seen + c >= rank) {
      // The overflow bucket has no upper bound: the largest bound is the best estimate.
      if (i >= bounds.length) return bounds[bounds.length - 1] ?? null;
      const upper = bounds[i] as number;
      const lower = i === 0 ? Math.min(0, upper) : (bounds[i - 1] as number);
      return lower + ((upper - lower) * (rank - seen)) / c;
    }
    seen += c;
  }
  return bounds[bounds.length - 1] ?? null;
}

interface Window {
  fromMs: number;
  toMs: number;
  stepMs: number;
  timestamps: number[];
}

@Injectable()
export class MetricsService {
  constructor(
    @Inject(STORAGE_POOL) private readonly pool: pg.Pool,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @Optional()
    @Inject(PostgresIngestSink)
    private readonly sink?: PostgresIngestSink,
  ) {}

  get enabled(): boolean {
    return this.config.metrics.enabled;
  }

  private range(q: CatalogQuery): { from: number; to: number } {
    const to = q.toUnixMs ?? Date.now();
    const from = q.fromUnixMs ?? to - HOUR_MS;
    if (to <= from) {
      throw new MetricsParamError(
        'Query parameter "toUnixMs" must be after "fromUnixMs".',
      );
    }
    return { from, to };
  }

  async catalog(q: CatalogQuery): Promise<MetricCatalogResponse> {
    const { from, to } = this.range(q);
    const params: unknown[] = [new Date(from), new Date(to)];
    const scope: Scope = { service: q.service, environment: q.environment };
    const svc = scopeSql(scope, adder(params))
      .map((c) => `AND ${c}`)
      .join(" ");
    const services = await this.pool.query<{ service_name: string }>(
      `SELECT DISTINCT service_name FROM metric_minutes
        WHERE minute >= $1 AND minute < $2 ${svc} ORDER BY service_name LIMIT 500`,
      params,
    );
    const instances = await this.pool.query<{
      service_name: string;
      environment: string | null;
      instance_id: string;
      first_ns: string;
      last_ns: string;
    }>(
      `SELECT service_name, environment, instance_id, min(time_ns)::text AS first_ns, max(time_ns)::text AS last_ns
         FROM metric_minutes
        WHERE minute >= $1 AND minute < $2 ${svc}
        GROUP BY service_name, environment, instance_id
        ORDER BY max(time_ns) DESC, service_name, environment NULLS FIRST, instance_id
        LIMIT ${MAX_INSTANCES_LISTED + 1}`,
      params,
    );
    const listed: MetricInstance[] = instances.rows
      .slice(0, MAX_INSTANCES_LISTED)
      .map((r) => ({
        service: r.service_name,
        ...(r.environment === null ? {} : { environment: r.environment }),
        instanceId: r.instance_id,
        firstSeenUnixMs: Number(BigInt(r.first_ns) / 1_000_000n),
        lastSeenUnixMs: Number(BigInt(r.last_ns) / 1_000_000n),
      }));
    const stats = this.sink?.metrics.stats();
    const app = this.config.metrics.all
      ? await this.appMetrics(params, svc)
      : undefined;
    return {
      retentionDays: this.config.retentionDays,
      minStepMs: MINUTE_MS,
      metrics: [...METRIC_CATALOG.map(definition), ...(app?.metrics ?? [])],
      services: services.rows.map((r) => r.service_name),
      instances: listed,
      instancesTruncated: instances.rows.length > MAX_INSTANCES_LISTED,
      ingest: {
        storedPoints: stats?.storedPoints ?? 0,
        overSeriesCap: stats?.overSeriesCap ?? 0,
        outOfRange: stats?.outOfRange ?? 0,
        rejectedPoints: stats?.rejectedPoints ?? 0,
        dropped: stats?.dropped ?? {
          unsupportedType: 0,
          notStored: 0,
          typeMismatch: 0,
          noRecordedValue: 0,
        },
        activeSeries: stats?.activeSeries ?? 0,
        maxSeriesPerService: this.config.metrics.maxSeriesPerService,
        maxSeries: this.config.metrics.maxSeries,
        ...(app === undefined
          ? {}
          : {
              overNameCap: stats?.overNameCap ?? 0,
              droppedAttributes: stats?.droppedAttributes ?? 0,
              maxNamesPerService: this.config.metrics.maxNamesPerService,
            }),
      },
      ...(app === undefined ? {} : { appMetricsTruncated: app.truncated }),
    };
  }

  /**
   * D-118: the application metrics with rows in the range and scope (`params`, `svc` as built by
   * `catalog`), each with the type and unit of its newest row and the attribute keys of its series.
   */
  private async appMetrics(
    params: unknown[],
    svc: string,
  ): Promise<{ metrics: MetricDefinition[]; truncated: boolean }> {
    const r = await this.pool.query<{
      metric_name: string;
      kind: CatalogKind;
      unit: string;
      keys: string[];
    }>(
      `WITH s AS (
         SELECT DISTINCT ON (metric_name, kind, unit, series_key) metric_name, kind, unit, attributes, time_ns
           FROM metric_minutes
          WHERE minute >= $1 AND minute < $2 ${svc} AND unit IS NOT NULL
          ORDER BY metric_name, kind, unit, series_key, minute DESC),
       m AS (SELECT metric_name, kind, unit, max(time_ns) AS t FROM s GROUP BY metric_name, kind, unit),
       k AS (SELECT DISTINCT metric_name, kind, unit, jsonb_object_keys(attributes) AS key FROM s)
       SELECT m.metric_name, m.kind, m.unit,
              coalesce((SELECT array_agg(k.key ORDER BY k.key) FROM k
                         WHERE k.metric_name = m.metric_name AND k.kind = m.kind AND k.unit = m.unit),
                       '{}') AS keys
         FROM m ORDER BY m.t DESC, m.metric_name, m.kind, m.unit
        LIMIT ${MAX_APP_METRICS_LISTED + 1}`,
      params,
    );
    const seen = new Set<string>();
    const metrics: MetricDefinition[] = [];
    for (const row of r.rows.slice(0, MAX_APP_METRICS_LISTED)) {
      // The newest type and unit of a name, as `series` serves it.
      if (seen.has(row.metric_name)) continue;
      seen.add(row.metric_name);
      metrics.push({
        ...definition(appEntry(row.metric_name, row.kind, row.unit)),
        app: true,
        attributeKeys: row.keys.slice(0, MAX_APP_ATTRIBUTE_KEYS_LISTED),
      });
    }
    metrics.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { metrics, truncated: r.rows.length > MAX_APP_METRICS_LISTED };
  }

  /** D-118: the type and unit of an application metric's newest row in the scope, or `undefined`. */
  private async appMetric(q: SeriesQuery): Promise<CatalogEntry | undefined> {
    const params: unknown[] = [q.metric];
    const scope = scopeSql(
      { service: q.service, environment: q.environment },
      adder(params),
    )
      .map((c) => `AND ${c}`)
      .join(" ");
    const r = await this.pool.query<{ kind: CatalogKind; unit: string }>(
      `SELECT kind, unit FROM metric_minutes
        WHERE metric_name = $1 AND unit IS NOT NULL ${scope}
        ORDER BY minute DESC, time_ns DESC LIMIT 1`,
      params,
    );
    const row = r.rows[0];
    return row === undefined
      ? undefined
      : appEntry(q.metric, row.kind, row.unit);
  }

  private window(q: SeriesQuery): Window {
    const { from, to } = this.range(q);
    let step = q.stepMs;
    if (step === undefined) {
      step = Math.max(
        MINUTE_MS,
        Math.ceil((to - from) / TARGET_BUCKETS / MINUTE_MS) * MINUTE_MS,
      );
    } else if (step % MINUTE_MS !== 0) {
      throw new MetricsParamError(
        'Query parameter "stepMs" must be a whole number of minutes.',
      );
    }
    const start = Math.floor(from / step) * step;
    const count = Math.ceil((to - start) / step);
    if (count > MAX_BUCKETS) {
      throw new MetricsParamError(
        `The range holds ${count} buckets of ${step / MINUTE_MS} min; at most ${MAX_BUCKETS}. Use a larger "stepMs" or a shorter range.`,
      );
    }
    const timestamps: number[] = [];
    for (let i = 0; i < count; i++) timestamps.push(start + i * step);
    return { fromMs: start, toMs: to, stepMs: step, timestamps };
  }

  async series(q: SeriesQuery): Promise<MetricSeriesResponse> {
    const catalogued = catalogEntry(q.metric);
    const entry =
      catalogued ??
      (this.config.metrics.all ? await this.appMetric(q) : undefined);
    if (entry === undefined) {
      throw new MetricsParamError(
        'Query parameter "metric" is not a stored metric; see api/v1/metrics/catalog.',
      );
    }
    if (entry.kind === "histogram" && q.by !== undefined) {
      throw new MetricsParamError(
        'Query parameter "by" is not supported for a histogram metric.',
      );
    }
    const win = this.window(q);
    const def = definition(entry);
    const aggregation = q.aggregation ?? def.defaultAggregation;
    const base = {
      metric: entry.name,
      kind: entry.kind,
      unit: def.unit,
      valueUnit: def.valueUnit,
      aggregation,
      stepMs: win.stepMs,
      fromUnixMs: win.fromMs,
      toUnixMs: win.toMs,
      timestamps: win.timestamps,
    };
    const filter = new Filter(
      entry.name,
      q,
      win,
      catalogued === undefined ? entry : undefined,
    );
    const instances = await this.contributingInstances(filter);
    let series: MetricSeries[];
    let groupInfo: { by: string; groupCount: number } | undefined;
    if (entry.kind === "histogram") {
      series = await this.histogramSeries(filter, win);
    } else if (q.by === undefined) {
      series = await this.scalarSeries(entry, filter, win, aggregation);
    } else {
      const top = await this.topGroups(filter, q.by);
      series = await this.scalarSeries(entry, filter, win, aggregation, {
        by: q.by,
        values: top.values,
      });
      if (q.by !== "instance") {
        groupInfo = { by: q.by, groupCount: top.total };
      }
    }
    return { ...base, series, instances, ...groupInfo };
  }

  private async contributingInstances(f: Filter): Promise<string[]> {
    const { sql, params } = f.where(1);
    const r = await this.pool.query<{ instance_id: string }>(
      `SELECT DISTINCT instance_id FROM metric_minutes WHERE ${sql} AND instance_id <> ''
        ORDER BY instance_id LIMIT ${MAX_INSTANCES_LISTED}`,
      params,
    );
    return r.rows.map((x) => x.instance_id);
  }

  /** The groups with the most rows (at most `MAX_INSTANCE_SERIES`), and how many there are. */
  private async topGroups(
    f: Filter,
    by: string,
  ): Promise<{ values: string[]; total: number }> {
    const { sql, params } = f.where(1);
    const g = groupExpr(by, params);
    const r = await this.pool.query<{ g: string; total: string }>(
      `SELECT g, count(*) OVER () AS total FROM (
         SELECT ${g} AS g, count(*) AS c FROM metric_minutes WHERE ${sql} GROUP BY 1) x
        ORDER BY c DESC, g LIMIT ${MAX_INSTANCE_SERIES}`,
      params,
    );
    return {
      values: r.rows.map((x) => x.g),
      total: Number(r.rows[0]?.total ?? 0),
    };
  }

  /** Counters and gauges: one SQL statement per request. */
  private async scalarSeries(
    entry: CatalogEntry,
    f: Filter,
    win: Window,
    aggregation: MetricAggregation,
    groups?: { by: string; values: string[] },
  ): Promise<MetricSeries[]> {
    const { sql, params } = f.where(1, true);
    let instanceFilter = "";
    let g = "''::text";
    if (groups !== undefined) {
      g = groupExpr(groups.by, params);
      params.push(groups.values);
      instanceFilter = `AND ${g} = ANY($${params.length}::text[])`;
    }
    params.push(win.stepMs);
    const step = `$${params.length}::bigint`;
    params.push(new Date(win.fromMs));
    const real = `$${params.length}::timestamptz`;
    const bucket = `((extract(epoch FROM minute)::bigint * 1000) / ${step}) * ${step}`;
    // `aggregation` and `merge` come from fixed enums, never from the request text.
    const across = { sum: "sum", avg: "avg", max: "max", min: "min" }[
      aggregation
    ];
    const perSeries =
      entry.kind === "counter"
        ? `
      r AS (
        SELECT minute, service_name, environment, instance_id, series_key, ${g} AS g, temporality,
               last_value, sum_value, start_ns, time_ns,
               lag(last_value) OVER w AS pl, lag(start_ns) OVER w AS ps, lag(time_ns) OVER w AS pt
          FROM metric_minutes
         WHERE ${sql} ${instanceFilter}
        WINDOW w AS (PARTITION BY service_name, environment, instance_id, series_key ORDER BY minute)),
      inc AS (
        SELECT ${bucket} AS bucket, service_name, environment, instance_id, series_key, g,
               CASE WHEN temporality = 'delta' THEN sum_value
                    WHEN pl IS NULL THEN NULL
                    WHEN last_value < pl OR start_ns <> ps THEN last_value
                    ELSE last_value - pl END AS inc,
               CASE WHEN temporality = 'delta' THEN 60::float8
                    ELSE (time_ns - pt)::float8 / 1e9 END AS dt
          FROM r WHERE minute >= ${real}),
      s AS (
        SELECT bucket, service_name, environment, instance_id, series_key, g, sum(inc) / sum(dt) AS v
          FROM inc WHERE inc IS NOT NULL AND dt > 0 AND dt <= ${MAX_GAP_SECONDS}
         GROUP BY bucket, service_name, environment, instance_id, series_key, g),
      i AS (
        SELECT bucket, service_name, environment, instance_id, g, sum(v) AS v FROM s
         GROUP BY bucket, service_name, environment, instance_id, g)`
        : `
      r AS (
        SELECT ${bucket} AS bucket, service_name, environment, instance_id, series_key, ${g} AS g,
               CASE WHEN '${aggregation}' = 'max' THEN max(max_value)
                    WHEN '${aggregation}' = 'min' THEN min(min_value)
                    ELSE sum(sum_value) / NULLIF(sum(count_value), 0) END AS v
          FROM metric_minutes
         WHERE ${sql} ${instanceFilter} AND minute >= ${real}
         GROUP BY bucket, service_name, environment, instance_id, series_key, g),
      i AS (
        SELECT bucket, service_name, environment, instance_id, g, ${entry.merge === "max" ? "max" : "sum"}(v) AS v
          FROM r GROUP BY bucket, service_name, environment, instance_id, g)`;
    const result = await this.pool.query<{
      bucket: string;
      g: string;
      v: number | null;
    }>(
      `WITH${perSeries}
       SELECT bucket, g, ${across}(v) AS v FROM i GROUP BY bucket, g`,
      params,
    );
    const index = new Map(win.timestamps.map((t, k) => [t, k]));
    const fresh = (): (number | null)[] =>
      new Array<number | null>(win.timestamps.length).fill(null);
    if (groups === undefined) {
      const values = fresh();
      for (const row of result.rows) {
        const k = index.get(Number(row.bucket));
        if (k !== undefined && row.v !== null) values[k] = row.v;
      }
      return [{ label: "all instances", values }];
    }
    const per = new Map<string, (number | null)[]>(
      groups.values.map((id) => [id, fresh()]),
    );
    for (const row of result.rows) {
      const k = index.get(Number(row.bucket));
      const values = per.get(row.g);
      if (k !== undefined && values !== undefined && row.v !== null)
        values[k] = row.v;
    }
    if (groups.by === "instance") {
      return groups.values.map((id) => ({
        label: id === "" ? "(no instance id)" : id,
        instanceId: id,
        values: per.get(id) as (number | null)[],
      }));
    }
    return groups.values.map((value) => ({
      label: value === "" ? "(none)" : value,
      group: value,
      values: per.get(value) as (number | null)[],
    }));
  }

  private async histogramSeries(
    f: Filter,
    win: Window,
  ): Promise<MetricSeries[]> {
    const { sql, params } = f.where(1, true);
    const result = await this.pool.query<{
      service_name: string;
      environment: string | null;
      instance_id: string;
      series_key: string;
      temporality: string;
      minute: Date;
      start_ns: string;
      time_ns: string;
      bounds: number[];
      buckets: number[];
      hist_count: number;
    }>(
      `SELECT service_name, environment, instance_id, series_key, temporality, minute,
              start_ns::text AS start_ns, time_ns::text AS time_ns, bounds, buckets, hist_count
         FROM metric_minutes WHERE ${sql}
        ORDER BY service_name, environment NULLS FIRST, instance_id, series_key, minute
        LIMIT ${MAX_HISTOGRAM_ROWS + 1}`,
      params,
    );
    if (result.rows.length > MAX_HISTOGRAM_ROWS) {
      throw new MetricsParamError(
        "The range holds too many histogram rows. Filter by service or instance, or use a shorter range.",
      );
    }
    // Increases per bucket, grouped by bounds (series with different bounds are not mixed).
    const byBounds = new Map<
      string,
      { bounds: number[]; total: number; sums: (number[] | undefined)[] }
    >();
    const index = new Map(win.timestamps.map((t, k) => [t, k]));
    let prev: (typeof result.rows)[number] | undefined;
    for (const row of result.rows) {
      const last = prev;
      prev = row;
      if (row.minute.getTime() < win.fromMs) continue;
      const contiguous =
        last !== undefined &&
        last.service_name === row.service_name &&
        last.environment === row.environment &&
        last.instance_id === row.instance_id &&
        last.series_key === row.series_key;
      let inc: number[] | null = null;
      if (row.temporality === "delta") {
        inc = row.buckets;
      } else if (contiguous) {
        const dt = Number(BigInt(row.time_ns) - BigInt(last.time_ns)) / 1e9;
        if (dt > 0 && dt <= MAX_GAP_SECONDS) {
          const reset =
            row.start_ns !== last.start_ns ||
            row.hist_count < last.hist_count ||
            row.buckets.some((c, i) => c < (last.buckets[i] ?? 0));
          inc = reset
            ? row.buckets
            : row.buckets.map((c, i) => c - (last.buckets[i] ?? 0));
        }
      }
      if (inc === null || row.bounds === null) continue;
      const k = index.get(
        Math.floor(row.minute.getTime() / win.stepMs) * win.stepMs,
      );
      if (k === undefined) continue;
      const key = JSON.stringify(row.bounds);
      let group = byBounds.get(key);
      if (group === undefined) {
        group = {
          bounds: row.bounds,
          total: 0,
          sums: new Array(win.timestamps.length),
        };
        byBounds.set(key, group);
      }
      let acc = group.sums[k];
      if (acc === undefined) {
        acc = new Array<number>(inc.length).fill(0);
        group.sums[k] = acc;
      }
      for (let i = 0; i < inc.length; i++) {
        acc[i] = (acc[i] ?? 0) + (inc[i] ?? 0);
        group.total += inc[i] ?? 0;
      }
    }
    let chosen:
      | { bounds: number[]; sums: (number[] | undefined)[] }
      | undefined;
    let best = -1;
    for (const g of byBounds.values()) {
      if (g.total > best) {
        best = g.total;
        chosen = g;
      }
    }
    return [
      { label: "p50", q: 0.5 },
      { label: "p95", q: 0.95 },
      { label: "p99", q: 0.99 },
    ].map(({ label, q }) => ({
      label,
      values: win.timestamps.map((_, k) => {
        const counts = chosen?.sums[k];
        return chosen === undefined || counts === undefined
          ? null
          : histogramQuantile(chosen.bounds, counts, q);
      }),
    }));
  }
}

/** The `WHERE` of one series request: metric, service, environment, instance, and the time range with lookback. */
class Filter {
  constructor(
    private readonly metric: string,
    private readonly q: SeriesQuery,
    private readonly win: Window,
    /** D-118: an application metric's served type and unit; other rows of the name are left out. */
    private readonly app?: CatalogEntry,
  ) {}

  /**
   * SQL text and its parameters, numbered from `start`. With `lookback`, rows start one step plus
   * `MAX_GAP_SECONDS` before the range, so the first bucket has a predecessor.
   */
  where(start: number, lookback = false): { sql: string; params: unknown[] } {
    const lead = lookback ? this.win.stepMs + MAX_GAP_SECONDS * 1000 : 0;
    const params: unknown[] = [
      this.metric,
      new Date(this.win.fromMs - lead),
      new Date(this.win.toMs),
    ];
    let sql = `metric_name = $${start} AND minute >= $${start + 1} AND minute < $${start + 2}`;
    // Service and environment through `scopeSql` (issue #28, D-101), numbered from `start`.
    const add = (value: unknown): string => {
      params.push(value);
      return `$${start + params.length - 1}`;
    };
    for (const c of scopeSql(
      { service: this.q.service, environment: this.q.environment },
      add,
    )) {
      sql += ` AND ${c}`;
    }
    if (this.q.instance !== undefined) {
      params.push(this.q.instance);
      sql += ` AND instance_id = $${start + params.length - 1}`;
    }
    if (this.app !== undefined) {
      sql += ` AND kind = ${add(this.app.kind)} AND unit = ${add(this.app.unit)}`;
    }
    for (const [key, value] of this.q.attributes ?? []) {
      sql += ` AND attributes ->> ${add(key)}::text = ${add(value)}`;
    }
    return { sql, params };
  }
}

/**
 * The group column of `by` (D-118): the instance, or the value of attribute `attr.<key>` (`''` when a
 * row has none), the key passed as a parameter appended to `params`.
 */
function groupExpr(by: string, params: unknown[]): string {
  if (by === "instance") return "instance_id";
  params.push(by.slice("attr.".length));
  return `coalesce(attributes ->> $${params.length}::text, '')`;
}
