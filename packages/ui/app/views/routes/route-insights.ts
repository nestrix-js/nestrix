import type {
  HistogramBucket,
  RouteCompareRow,
  RouteHistogramResponse,
} from "@nestrix-js/protocol";

import { formatDuration } from "@/lib/format";

/** The `route`/`method` and duration range of the request list that shows one histogram bucket. */
export function bucketFilter(
  histogram: Pick<RouteHistogramResponse, "route" | "method">,
  bucket: HistogramBucket,
): Record<string, string | number> {
  const filter: Record<string, string | number> = { route: histogram.route };
  if (histogram.method !== null) filter.method = histogram.method;
  // The first bucket starts at 0 and the last has no upper bound: leave those ends open.
  if (bucket.fromMs > 0) filter.minDurationMs = bucket.fromMs;
  if (bucket.toMs !== null) filter.maxDurationMs = bucket.toMs;
  return filter;
}

/** `/?route=...` for the router: the request list with that filter. */
export function requestsLink(filter: Record<string, string | number>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter))
    params.set(key, String(value));
  return `/?${params.toString()}`;
}

/** "10 ms to 15 ms", "up to 1.0 ms", "over 60 s". */
export function bucketLabel(bucket: HistogramBucket): string {
  if (bucket.toMs === null) return `over ${formatDuration(bucket.fromMs)}`;
  if (bucket.fromMs === 0) return `up to ${formatDuration(bucket.toMs)}`;
  return `${formatDuration(bucket.fromMs)} to ${formatDuration(bucket.toMs)}`;
}

/** Index of the bucket holding `ms` (the buckets are `(from, to]`, the first starts at 0). */
export function bucketIndexOf(
  buckets: readonly HistogramBucket[],
  ms: number,
): number {
  const i = buckets.findIndex(
    (b) => ms <= (b.toMs ?? Number.POSITIVE_INFINITY),
  );
  return i < 0 ? buckets.length - 1 : i;
}

/**
 * Where a percentile marker sits on a chart whose x is the bucket index: the bucket's centre, so
 * the marker stays inside the bar that holds the value.
 */
export function markerX(
  buckets: readonly HistogramBucket[],
  ms: number,
): number {
  return bucketIndexOf(buckets, ms);
}

/** Thresholds of a regression: a slower p95 or a higher error rate. */
export const REGRESSION = {
  p95Ratio: 0.2,
  p95Ms: 5,
  errorRate: 0.02,
} as const;

export type Verdict = "regression" | "improvement" | "same";

/** A row is a regression when p95 got at least 20% and 5 ms slower, or the error rate rose 2 points. */
export function verdictOf(row: RouteCompareRow): Verdict {
  const { before, after, delta } = row;
  const slower =
    delta.p95Ms !== null &&
    delta.p95Ms >= REGRESSION.p95Ms &&
    delta.p95Ms >= before.p95Ms * REGRESSION.p95Ratio;
  if (slower || delta.errorRate >= REGRESSION.errorRate) return "regression";
  const faster =
    delta.p95Ms !== null &&
    -delta.p95Ms >= REGRESSION.p95Ms &&
    -delta.p95Ms >= before.p95Ms * REGRESSION.p95Ratio;
  if ((faster || delta.errorRate <= -REGRESSION.errorRate) && after.count > 0)
    return "improvement";
  return "same";
}

export type CompareSortKey =
  | "route"
  | "count"
  | "errorRate"
  | "p50Ms"
  | "p95Ms";

const sortValue = (row: RouteCompareRow, key: CompareSortKey) => {
  switch (key) {
    case "route":
      return `${row.route} ${row.method}`;
    case "count":
      return row.delta.count;
    case "errorRate":
      return row.delta.errorRate;
    case "p50Ms":
      return row.delta.p50Ms;
    case "p95Ms":
      return row.delta.p95Ms;
  }
};

/** Sorts by a delta column (or the route name); rows without a delta go last, whatever the order. */
export function sortCompareRows(
  rows: readonly RouteCompareRow[],
  key: CompareSortKey,
  direction: "asc" | "desc",
): RouteCompareRow[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x === "string" || typeof y === "string")
      return sign * String(x).localeCompare(String(y));
    return sign * (x - y);
  });
}

/** "+12 ms", "-3.4 ms", "-" when unknown. */
export function formatDeltaMs(ms: number | null): string {
  if (ms === null) return "-";
  if (ms === 0) return "0 ms";
  return `${ms > 0 ? "+" : "-"}${formatDuration(Math.abs(ms))}`;
}

/** "+2.0 pt", "-0.5 pt": percentage points of error rate. */
export function formatDeltaRate(rate: number): string {
  const points = rate * 100;
  if (points === 0) return "0 pt";
  return `${points > 0 ? "+" : "-"}${Math.abs(points).toFixed(1)} pt`;
}

export const formatDeltaCount = (n: number) => (n > 0 ? `+${n}` : String(n));
