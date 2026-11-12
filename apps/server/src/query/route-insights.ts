/**
 * Route insights (P9-02) for the standalone server: the histogram of one route, the comparison of
 * two windows (from `route_minutes`, counted before sampling) and of two releases (from the stored,
 * sampled `traces`). The pure parts (bucket bounds, joining, deltas, the release SQL) live here so
 * they are tested without a database; `QueryService` runs the queries.
 */
import type {
  CompareDelta,
  CompareSide,
  HistogramBucket,
  RouteCompareRow,
} from "@nestrix-js/protocol";
import {
  HISTOGRAM_BUCKETS,
  HISTOGRAM_UPPER_BOUNDS_MS,
} from "../storage/histogram.js";

const round = (ms: number) => Math.round(ms * 1000) / 1000;

/** The 30 buckets of a summed histogram, with their bounds. */
export function bucketsOf(hist: readonly number[]): HistogramBucket[] {
  const out: HistogramBucket[] = [];
  for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
    out.push({
      fromMs: i === 0 ? 0 : round(HISTOGRAM_UPPER_BOUNDS_MS[i - 1] as number),
      toMs:
        i === HISTOGRAM_BUCKETS - 1
          ? null
          : round(HISTOGRAM_UPPER_BOUNDS_MS[i] as number),
      count: hist[i] ?? 0,
    });
  }
  return out;
}

/** `after - before`; percentile deltas are `null` when either side has no request. */
export function deltaOf(before: CompareSide, after: CompareSide): CompareDelta {
  const rate = (s: CompareSide) => (s.count === 0 ? 0 : s.errors / s.count);
  const both = before.count > 0 && after.count > 0;
  return {
    count: after.count - before.count,
    errorRate: round(rate(after) - rate(before)),
    p50Ms: both ? round(after.p50Ms - before.p50Ms) : null,
    p95Ms: both ? round(after.p95Ms - before.p95Ms) : null,
  };
}

export interface SideRow extends CompareSide {
  method: string;
  route: string;
}

/** Joins two sets of per-route sides into rows, busiest (by the `after` count) first. */
export function compareRows(
  before: readonly SideRow[],
  after: readonly SideRow[],
): RouteCompareRow[] {
  const key = (r: SideRow) => `${r.method}\u0000${r.route}`;
  const side = (r: SideRow | undefined): CompareSide =>
    r === undefined
      ? { count: 0, errors: 0, p50Ms: 0, p95Ms: 0 }
      : { count: r.count, errors: r.errors, p50Ms: r.p50Ms, p95Ms: r.p95Ms };
  const b = new Map(before.map((r) => [key(r), r]));
  const a = new Map(after.map((r) => [key(r), r]));
  const rows: RouteCompareRow[] = [];
  for (const k of new Set([...b.keys(), ...a.keys()])) {
    const any = (a.get(k) ?? b.get(k)) as SideRow;
    const rb = side(b.get(k));
    const ra = side(a.get(k));
    rows.push({
      method: any.method,
      route: any.route,
      before: rb,
      after: ra,
      delta: deltaOf(rb, ra),
    });
  }
  return rows.sort(
    (x, y) =>
      y.after.count - x.after.count ||
      y.before.count - x.before.count ||
      (x.route < y.route ? -1 : x.route > y.route ? 1 : 0) ||
      (x.method < y.method ? -1 : x.method > y.method ? 1 : 0),
  );
}

export const MAX_RELEASES = 20;

/**
 * Per route and release, the count, error count and nearest-rank p50 and p95 (`percentile_disc`,
 * the embedded dashboard's definition) of the HTTP traces of `releaseA` and `releaseB`.
 */
export function releaseCompareSql(
  releaseA: string,
  releaseB: string,
  service: string | undefined,
): { text: string; values: unknown[] } {
  const values: unknown[] = [[releaseA, releaseB]];
  let serviceFilter = "";
  if (service !== undefined) {
    values.push(service);
    serviceFilter = `AND service_name = $${values.length}`;
  }
  return {
    text: `SELECT release, http_method AS method, http_route AS route,
                  count(*)::int AS count,
                  (count(*) FILTER (WHERE is_error))::int AS errors,
                  (percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ns))::float8 / 1e6 AS p50_ms,
                  (percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ns))::float8 / 1e6 AS p95_ms
             FROM traces
            WHERE release = ANY($1::text[]) AND trace_type = 'http'
                  AND http_route IS NOT NULL AND http_method IS NOT NULL ${serviceFilter}
            GROUP BY release, http_method, http_route`,
    values,
  };
}

/** The releases seen, most recently stored first. */
export function releasesSql(service: string | undefined): {
  text: string;
  values: unknown[];
} {
  const values: unknown[] = [];
  let where = "release IS NOT NULL";
  if (service !== undefined) {
    values.push(service);
    where += ` AND service_name = $1`;
  }
  return {
    text: `SELECT release FROM traces WHERE ${where}
            GROUP BY release ORDER BY max(seq) DESC LIMIT ${MAX_RELEASES}`,
    values,
  };
}

export interface ReleaseRow {
  release: string;
  method: string;
  route: string;
  count: number;
  errors: number;
  p50_ms: number | string;
  p95_ms: number | string;
}

/** Splits the release query's rows into the two sides. */
export function releaseSides(
  rows: readonly ReleaseRow[],
  releaseA: string,
  releaseB: string,
): { a: SideRow[]; b: SideRow[] } {
  const side = (r: ReleaseRow): SideRow => ({
    method: r.method,
    route: r.route,
    count: Number(r.count),
    errors: Number(r.errors),
    p50Ms: round(Number(r.p50_ms)),
    p95Ms: round(Number(r.p95_ms)),
  });
  return {
    a: rows.filter((r) => r.release === releaseA).map(side),
    b: rows.filter((r) => r.release === releaseB).map(side),
  };
}
