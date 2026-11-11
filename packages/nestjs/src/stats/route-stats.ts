/**
 * Pre-sampling per-route statistics (architecture §4.6 "Statistics under sampling", D-35).
 *
 * The HTTP request hook (`src/http/server.ts`) calls `record()` once per request at the raw
 * response's `close`, whether or not the server span is recording. The dashboard's routes
 * endpoint (P2-06) calls `query()`.
 *
 * Layout, per key (`METHOD route-template`):
 * - a ring of 60 one-minute slots, each tagged with the minute (since the Unix epoch) it holds,
 *   so a slot left over from an earlier hour is recognised and cleared on reuse;
 * - per slot: request count, error count, the largest duration, and a 30-bucket log-spaced
 *   duration histogram (1 ms to 60 s, plus an underflow and an overflow bucket).
 *
 * Every array is a typed array allocated once, when the key is first seen. `record()` allocates
 * nothing: keys are looked up in two nested maps (method, then route), so no key string is
 * built per request. At most `MAX_ROUTE_KEYS` keys; any further key is counted under one
 * shared `other` key.
 *
 * Nothing here imports OpenTelemetry or Nest. `record()` and `query()` never throw on any input
 * (a non-finite or negative duration counts as 0 ms; a non-finite time is ignored).
 *
 * Response shapes mirror `RouteStatsResponse`, `RouteStats` and `RouteSeriesPoint` in
 * `@nestrix/protocol` (P2-01). They are declared here rather than imported because
 * `@nestrix/nestjs` has no dependency on that private package yet; `test/stats-unit.test.ts`
 * checks assignability both ways, so drift fails `tsc`.
 */

/** Width of one series bucket. */
export const BUCKET_MS = 60_000;
/** Number of one-minute slots kept: the last hour. */
export const WINDOW_BUCKETS = 60;
/** Distinct keys tracked before further keys go to `other`. */
export const MAX_ROUTE_KEYS = 500;
/** Route of a request no handler matched (keyed `METHOD (unmatched)`). */
export const UNMATCHED_ROUTE = "(unmatched)";
/** Method and route of the shared overflow key. */
export const OTHER_METHOD = "*";
export const OTHER_ROUTE = "(other)";

/** Log-spaced bounds: bucket 0 holds `<= 1 ms`, bucket i (1..28) holds `(B[i-1], B[i]]`, bucket 29 `> 60 s`. */
const MIN_MS = 1;
const MAX_MS = 60_000;
const STEPS = 28;
export const HISTOGRAM_BUCKETS = STEPS + 2; // 30
const LN_STEP = Math.log(MAX_MS / MIN_MS) / STEPS;

/** Upper bound of bucket i, for i in 0..28. Bucket 29 has no upper bound. */
export const HISTOGRAM_UPPER_BOUNDS_MS: readonly number[] = Array.from(
  { length: STEPS + 1 },
  (_, i) => (i === STEPS ? MAX_MS : MIN_MS * Math.exp(i * LN_STEP)),
);
const UPPER = Float64Array.from(HISTOGRAM_UPPER_BOUNDS_MS);

/** The histogram bucket a duration falls in. Never throws; NaN and negatives go to bucket 0. */
export function bucketIndex(ms: number): number {
  if (!(ms > MIN_MS)) return 0;
  if (ms > MAX_MS) return HISTOGRAM_BUCKETS - 1;
  let i = Math.ceil(Math.log(ms / MIN_MS) / LN_STEP);
  if (i < 1) i = 1;
  else if (i > STEPS) i = STEPS;
  // Correct a floating-point rounding at a bound, so `(B[i-1], B[i]]` holds exactly.
  if (ms <= (UPPER[i - 1] as number)) i--;
  else if (ms > (UPPER[i] as number)) i++;
  return i;
}

export interface RouteSeriesPointResult {
  /** Start of the bucket, Unix ms. */
  timeUnixMs: number;
  count: number;
  errors: number;
  p50Ms?: number;
  p95Ms?: number;
}

export interface RouteStatsResult {
  method: string;
  route: string;
  count: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  series: RouteSeriesPointResult[];
}

export interface RouteStatsResponseResult {
  windowMinutes: number;
  bucketMs: number;
  fromUnixMs: number;
  toUnixMs: number;
  routes: RouteStatsResult[];
}

/**
 * The wall clock the minute buckets use (`Date.now()`, correct after a laptop sleeps, unlike
 * `performance.timeOrigin + performance.now()`). The request hook records with the same clock, and
 * durations come from `performance.now()`. Query with this so buckets line up.
 */
export function statsNow(): number {
  return Date.now();
}

class Series {
  readonly minute = new Int32Array(WINDOW_BUCKETS).fill(-1);
  readonly count = new Uint32Array(WINDOW_BUCKETS);
  readonly errors = new Uint32Array(WINDOW_BUCKETS);
  readonly max = new Float64Array(WINDOW_BUCKETS);
  readonly hist = new Uint32Array(WINDOW_BUCKETS * HISTOGRAM_BUCKETS);
  constructor(
    readonly method: string,
    readonly route: string,
  ) {}
}

export class RouteStatistics {
  /** Unix ms from which statistics have been counted (the dashboard's `meta.statistics.sinceUnixMs`). */
  readonly sinceUnixMs: number;
  private readonly byMethod = new Map<string, Map<string, Series>>();
  private keys = 0;
  private other: Series | undefined;

  constructor(nowUnixMs: number = statsNow()) {
    this.sinceUnixMs = nowUnixMs;
  }

  /** Distinct keys tracked, not counting `other`. */
  get keyCount(): number {
    return this.keys;
  }

  /**
   * Counts one request. Allocation-free once the key exists. Never throws.
   *
   * @param method upper-case method, or `_OTHER`
   * @param route route template, or `UNMATCHED_ROUTE`
   * @param durationMs request duration
   * @param error 5xx, or a handler exception that maps to 5xx
   * @param nowUnixMs wall time of the response's `close`
   */
  record(
    method: string,
    route: string,
    durationMs: number,
    error: boolean,
    nowUnixMs: number,
  ): void {
    if (!Number.isFinite(nowUnixMs)) return;
    const s = this.seriesFor(method, route);
    const minute = Math.floor(nowUnixMs / BUCKET_MS);
    const slot = minute % WINDOW_BUCKETS;
    if (s.minute[slot] !== minute) {
      s.minute[slot] = minute;
      s.count[slot] = 0;
      s.errors[slot] = 0;
      s.max[slot] = 0;
      s.hist.fill(0, slot * HISTOGRAM_BUCKETS, (slot + 1) * HISTOGRAM_BUCKETS);
    }
    const ms = durationMs >= 0 && Number.isFinite(durationMs) ? durationMs : 0;
    (s.count[slot] as number)++;
    if (error) (s.errors[slot] as number)++;
    if (ms > (s.max[slot] as number)) s.max[slot] = ms;
    (s.hist[slot * HISTOGRAM_BUCKETS + bucketIndex(ms)] as number)++;
  }

  /**
   * Per-route totals and a one-point-per-minute series for the last `windowMinutes` minutes
   * (clamped to 1..60), the current minute included. Routes with no request in the window are
   * left out; the rest are ordered by count, highest first. Never throws.
   */
  query(
    windowMinutes: number,
    nowUnixMs: number = statsNow(),
  ): RouteStatsResponseResult {
    const window = Math.min(
      WINDOW_BUCKETS,
      Math.max(1, Math.floor(Number(windowMinutes) || 0)),
    );
    const now = Number.isFinite(nowUnixMs) ? nowUnixMs : statsNow();
    const last = Math.floor(now / BUCKET_MS);
    const first = last - window + 1;
    const routes: RouteStatsResult[] = [];
    const merged = new Uint32Array(HISTOGRAM_BUCKETS);
    const all: Series[] = [];
    for (const byRoute of this.byMethod.values()) {
      for (const s of byRoute.values()) all.push(s);
    }
    if (this.other) all.push(this.other);

    for (const s of all) {
      merged.fill(0);
      let count = 0;
      let errors = 0;
      let max = 0;
      const series: RouteSeriesPointResult[] = [];
      for (let m = first; m <= last; m++) {
        const slot = ((m % WINDOW_BUCKETS) + WINDOW_BUCKETS) % WINDOW_BUCKETS;
        const point: RouteSeriesPointResult = {
          timeUnixMs: m * BUCKET_MS,
          count: 0,
          errors: 0,
        };
        if (s.minute[slot] === m && (s.count[slot] as number) > 0) {
          const c = s.count[slot] as number;
          const slotMax = s.max[slot] as number;
          const start = slot * HISTOGRAM_BUCKETS;
          const hist = s.hist.subarray(start, start + HISTOGRAM_BUCKETS);
          point.count = c;
          point.errors = s.errors[slot] as number;
          point.p50Ms = quantile(hist, c, 0.5, slotMax);
          point.p95Ms = quantile(hist, c, 0.95, slotMax);
          count += c;
          errors += point.errors;
          if (slotMax > max) max = slotMax;
          for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
            merged[i] = (merged[i] as number) + (hist[i] as number);
          }
        }
        series.push(point);
      }
      if (count === 0) continue;
      routes.push({
        method: s.method,
        route: s.route,
        count,
        errors,
        p50Ms: quantile(merged, count, 0.5, max),
        p95Ms: quantile(merged, count, 0.95, max),
        p99Ms: quantile(merged, count, 0.99, max),
        maxMs: round(max),
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
      windowMinutes: window,
      bucketMs: BUCKET_MS,
      fromUnixMs: first * BUCKET_MS,
      toUnixMs: now,
      routes,
    };
  }

  private seriesFor(method: string, route: string): Series {
    let byRoute = this.byMethod.get(method);
    if (byRoute !== undefined) {
      const found = byRoute.get(route);
      if (found !== undefined) return found;
    }
    if (this.keys >= MAX_ROUTE_KEYS) {
      this.other ??= new Series(OTHER_METHOD, OTHER_ROUTE);
      return this.other;
    }
    if (byRoute === undefined) {
      byRoute = new Map();
      this.byMethod.set(method, byRoute);
    }
    const created = new Series(method, route);
    byRoute.set(route, created);
    this.keys++;
    return created;
  }
}

/**
 * The `q` quantile (nearest rank, interpolated linearly inside its bucket) of a histogram
 * holding `total` values, capped at the largest value seen. Exact to within the bucket that
 * holds the true value.
 */
export function quantile(
  hist: Uint32Array,
  total: number,
  q: number,
  max: number,
): number {
  if (total <= 0) return 0;
  const rank = Math.max(1, Math.ceil(q * total));
  let cumulative = 0;
  for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
    const n = hist[i] as number;
    if (n === 0) continue;
    if (cumulative + n >= rank) {
      const lo = i === 0 ? 0 : (UPPER[i - 1] as number);
      const hi = i === HISTOGRAM_BUCKETS - 1 ? max : (UPPER[i] as number);
      const value = lo + ((rank - cumulative) / n) * Math.max(0, hi - lo);
      return round(Math.min(value, max));
    }
    cumulative += n;
  }
  return round(max);
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
