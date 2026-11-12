/**
 * Route insights (P9-02): the latency histogram of one route, and the comparison of two windows
 * (route statistics, counted before sampling) or two releases (stored, sampled traces).
 *
 * Pure functions over `RouteStatistics` and the trace store; none throws. Response shapes are
 * `@nestrix-js/protocol`'s (type-only import, erased at build; nothing here is reachable from the
 * package's public entry).
 */
import type {
  CompareDelta,
  CompareSide,
  HistogramBucket,
  RouteCompareRow,
  RouteHistogramResponse,
  RouteReleaseCompareResponse,
  RouteWindowCompareResponse,
} from "@nestrix-js/protocol";
import type { TraceStore } from "../store/store.js";
import { traceTypeOf } from "../store/store.js";
import {
  BUCKET_MS,
  HISTOGRAM_BUCKETS,
  HISTOGRAM_UPPER_BOUNDS_MS,
  quantile,
  type RouteAggregate,
  type RouteStatistics,
  WINDOW_BUCKETS,
} from "./route-stats.js";

const round = (ms: number) => Math.round(ms * 1000) / 1000;

/** The 30 buckets of a merged histogram, with their bounds. */
export function bucketsOf(hist: ArrayLike<number>): HistogramBucket[] {
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

/**
 * The histogram of `route` (of `method` only, when given) over the last `windowMinutes` minutes,
 * with its percentiles. A route nothing was counted for answers an all-zero histogram.
 */
export function routeHistogram(
  stats: RouteStatistics,
  route: string,
  method: string | undefined,
  windowMinutes: number,
  now: number,
): RouteHistogramResponse {
  const last = Math.floor(now / BUCKET_MS);
  const first = last - windowMinutes + 1;
  const merged = new Uint32Array(HISTOGRAM_BUCKETS);
  let count = 0;
  let max = 0;
  for (const a of stats.aggregate(first, last)) {
    if (a.route !== route || (method !== undefined && a.method !== method))
      continue;
    count += a.count;
    if (a.max > max) max = a.max;
    for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
      (merged[i] as number) += a.hist[i] as number;
    }
  }
  return {
    method: method ?? null,
    route,
    windowMinutes,
    fromUnixMs: first * BUCKET_MS,
    toUnixMs: now,
    count,
    p50Ms: quantile(merged, count, 0.5, max),
    p95Ms: quantile(merged, count, 0.95, max),
    p99Ms: quantile(merged, count, 0.99, max),
    maxMs: round(max),
    buckets: bucketsOf(merged),
  };
}

const EMPTY_SIDE: CompareSide = { count: 0, errors: 0, p50Ms: 0, p95Ms: 0 };

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

interface SideRow extends CompareSide {
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
      ? { ...EMPTY_SIDE }
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

const sideOfAggregate = (a: RouteAggregate): SideRow => ({
  method: a.method,
  route: a.route,
  count: a.count,
  errors: a.errors,
  p50Ms: quantile(a.hist, a.count, 0.5, a.max),
  p95Ms: quantile(a.hist, a.count, 0.95, a.max),
});

const MAX_RELEASES = 20;

/** Releases seen in the stored traces, most recently seen first. */
export function releasesSeen(store: TraceStore | undefined): string[] {
  const seen = new Map<string, number>();
  store?.scanTraces(0, (root, _spans, resource) => {
    const release = resource["service.version"];
    if (typeof release !== "string" || release === "") return;
    const at = seen.get(release) ?? 0;
    if (root.startTimeUnixMs >= at) seen.set(release, root.startTimeUnixMs);
  });
  return [...seen.entries()]
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .slice(0, MAX_RELEASES)
    .map(([release]) => release);
}

/**
 * Whether route statistics cover the `windowMinutes` before the last `windowMinutes`, and why not.
 * The statistics keep the last 60 minutes, so a 60-minute window has no previous window to compare
 * with; a previous window that began before the statistics did is only partly counted. Both cases
 * are said in `note`.
 */
export function windowCoverage(
  stats: RouteStatistics,
  windowMinutes: number,
  now: number,
): { previousCovered: boolean; note: string | null } {
  const last = Math.floor(now / BUCKET_MS);
  const curFirst = last - windowMinutes + 1;
  const prevFirst = curFirst - windowMinutes;
  const kept = prevFirst >= last - WINDOW_BUCKETS + 1;
  const counted = stats.sinceUnixMs <= prevFirst * BUCKET_MS;
  let note: string | null = null;
  if (!kept) {
    note = `Statistics are kept for the last ${WINDOW_BUCKETS} minutes, so the ${windowMinutes} minutes before the last ${windowMinutes} are not available. Compare 15 minutes instead.`;
  } else if (!counted) {
    note =
      "Statistics started less than two windows ago, so the previous window is only partly counted.";
  }
  return { previousCovered: kept && counted, note };
}

/** The last `windowMinutes` against the `windowMinutes` before them (see {@link windowCoverage}). */
export function windowCompare(
  stats: RouteStatistics,
  store: TraceStore | undefined,
  windowMinutes: number,
  now: number,
): RouteWindowCompareResponse {
  const last = Math.floor(now / BUCKET_MS);
  const curFirst = last - windowMinutes + 1;
  const prevLast = curFirst - 1;
  const prevFirst = prevLast - windowMinutes + 1;
  const { previousCovered, note } = windowCoverage(stats, windowMinutes, now);
  const kept = prevFirst >= last - WINDOW_BUCKETS + 1;
  return {
    mode: "window",
    windowMinutes,
    previous: {
      fromUnixMs: prevFirst * BUCKET_MS,
      toUnixMs: curFirst * BUCKET_MS,
    },
    current: { fromUnixMs: curFirst * BUCKET_MS, toUnixMs: now },
    previousCovered,
    note,
    releases: releasesSeen(store),
    routes: compareRows(
      // Slots older than the last hour may still hold stale minutes: leave them out.
      kept ? stats.aggregate(prevFirst, prevLast).map(sideOfAggregate) : [],
      stats.aggregate(curFirst, last).map(sideOfAggregate),
    ),
  };
}

/** Nearest-rank quantile of an ascending list. */
function rank(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.max(1, Math.ceil(q * sorted.length)) - 1;
  return round(sorted[Math.min(i, sorted.length - 1)] as number);
}

/** Two releases, per route, from the stored (sampled) HTTP traces. */
export function releaseCompare(
  store: TraceStore | undefined,
  releaseA: string,
  releaseB: string,
): RouteReleaseCompareResponse {
  interface Acc {
    method: string;
    route: string;
    errors: number;
    durations: number[];
  }
  const accs = new Map<string, Map<string, Acc>>([
    [releaseA, new Map()],
    [releaseB, new Map()],
  ]);
  store?.scanTraces(0, (root, _spans, resource) => {
    const byRoute = accs.get(String(resource["service.version"]));
    if (byRoute === undefined || traceTypeOf(root) !== "http") return;
    const route = root.attributes["http.route"];
    const method = root.attributes["http.request.method"];
    if (typeof route !== "string" || typeof method !== "string") return;
    const key = `${method}\u0000${route}`;
    let acc = byRoute.get(key);
    if (acc === undefined) {
      acc = { method, route, errors: 0, durations: [] };
      byRoute.set(key, acc);
    }
    acc.durations.push(root.durationMs);
    if (root.status.code === "error") acc.errors++;
  });
  const sides = (byRoute: Map<string, Acc> | undefined): SideRow[] =>
    [...(byRoute?.values() ?? [])].map((a) => {
      const sorted = a.durations.slice().sort((x, y) => x - y);
      return {
        method: a.method,
        route: a.route,
        count: sorted.length,
        errors: a.errors,
        p50Ms: rank(sorted, 0.5),
        p95Ms: rank(sorted, 0.95),
      };
    });
  return {
    mode: "release",
    releaseA,
    releaseB,
    releases: releasesSeen(store),
    routes: compareRows(sides(accs.get(releaseA)), sides(accs.get(releaseB))),
  };
}
