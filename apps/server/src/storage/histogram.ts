/**
 * The latency histogram of the rollup tables (`route_minutes.hist`, `class_minutes.hist`),
 * shared by the writer (which fills it) and the query API (which estimates percentiles from it).
 *
 * Bounds are the embedded route statistics' (`packages/nestjs/src/stats/route-stats.ts`), so the
 * embedded and standalone backends estimate the same percentile from the same durations:
 *
 * - 30 buckets; bucket 0 holds `<= 1 ms`, bucket i (1..28) holds `(B[i-1], B[i]]`, bucket 29 `> 60 s`;
 * - B[i] = 1 ms * (60 000)^(i / 28), log-spaced (each bound about 1.48 times the previous one).
 *
 * A row's histogram is an `integer[]` of length {@link HISTOGRAM_BUCKETS}; rows are summed
 * element-wise (the SQL function `nestrix_hist_add`, or {@link addHistograms} in JS) before
 * {@link estimateQuantile} is applied, with the summed `count` and the largest `max_ms`.
 *
 * Accuracy: the estimate interpolates linearly inside the bucket that holds the nearest-rank
 * value, so it is within that bucket (about 48% wide relative to its lower bound) and never above
 * the largest value seen.
 */

const MIN_MS = 1;
const MAX_MS = 60_000;
const STEPS = 28;
export const HISTOGRAM_BUCKETS = STEPS + 2; // 30
const LN_STEP = Math.log(MAX_MS / MIN_MS) / STEPS;

/** Upper bound of bucket i in ms, for i in 0..28. Bucket 29 has no upper bound. */
export const HISTOGRAM_UPPER_BOUNDS_MS: readonly number[] = Array.from(
  { length: STEPS + 1 },
  (_, i) => (i === STEPS ? MAX_MS : MIN_MS * Math.exp(i * LN_STEP)),
);
const UPPER = Float64Array.from(HISTOGRAM_UPPER_BOUNDS_MS);

/** The bucket a duration falls in. Never throws; NaN and negatives go to bucket 0. */
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

/** A histogram with every bucket 0. */
export function emptyHistogram(): number[] {
  return new Array<number>(HISTOGRAM_BUCKETS).fill(0);
}

/** Element-wise sum into `into` (missing entries count as 0). Returns `into`. */
export function addHistograms(
  into: number[],
  other: readonly number[],
): number[] {
  for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
    into[i] = (into[i] ?? 0) + (other[i] ?? 0);
  }
  return into;
}

/**
 * The `q` quantile (0..1) of a histogram holding `total` values whose largest is `maxMs`:
 * nearest rank, interpolated linearly inside its bucket, capped at `maxMs`, rounded to
 * microseconds. 0 when `total` is 0. The same function as the embedded `quantile`.
 */
export function estimateQuantile(
  hist: readonly number[],
  total: number,
  q: number,
  maxMs: number,
): number {
  if (!(total > 0)) return 0;
  const rank = Math.max(1, Math.ceil(q * total));
  let cumulative = 0;
  for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
    const n = hist[i] ?? 0;
    if (n === 0) continue;
    if (cumulative + n >= rank) {
      const lo = i === 0 ? 0 : (UPPER[i - 1] as number);
      const hi = i === HISTOGRAM_BUCKETS - 1 ? maxMs : (UPPER[i] as number);
      const value = lo + ((rank - cumulative) / n) * Math.max(0, hi - lo);
      return round(Math.min(value, maxMs));
    }
    cumulative += n;
  }
  return round(maxMs);
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
