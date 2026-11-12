/**
 * Route insights (phase 9, P9-02): the latency histogram of one route and the comparison of
 * windows or releases. Types and parameter specs only.
 *
 * Numbers counted before sampling: the histogram and the window comparison come from the route
 * statistics. Numbers built from stored, sampled traces: the release comparison.
 */

/** `GET <path>/api/v1/routes/histogram`: `route` is required, `method` narrows it, `service` filters. */
export const routeHistogramParams = {
  method: { kind: "string", maxLength: 16 },
  route: { kind: "string", maxLength: 512 },
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
  service: { kind: "string", maxLength: 256 },
} as const;
export type RouteHistogramParamsSpec = typeof routeHistogramParams;

/**
 * `GET <path>/api/v1/routes/compare`. With `releaseA` and `releaseB` (both required together) it
 * compares two releases from the stored traces; otherwise it compares the last `windowMinutes`
 * with the `windowMinutes` before them (`previous` is 1: the only comparison offered).
 */
export const routeCompareParams = {
  windowMinutes: {
    kind: "int",
    min: 15,
    max: 60,
    oneOf: [15, 60],
    default: 15,
  },
  previous: { kind: "int", min: 1, max: 1, default: 1 },
  releaseA: { kind: "string", maxLength: 255 },
  releaseB: { kind: "string", maxLength: 255 },
  service: { kind: "string", maxLength: 256 },
} as const;
export type RouteCompareParamsSpec = typeof routeCompareParams;

/** One histogram bucket: durations in `(fromMs, toMs]`; the first starts at 0, the last has `toMs: null`. */
export interface HistogramBucket {
  fromMs: number;
  toMs: number | null;
  count: number;
}

/** `GET api/v1/routes/histogram`: counted before sampling. */
export interface RouteHistogramResponse {
  /** The method asked for, or `null` when the histogram merges every method of the route. */
  method: string | null;
  route: string;
  windowMinutes: number;
  fromUnixMs: number;
  toUnixMs: number;
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  buckets: HistogramBucket[];
}

/** One side of a comparison. Percentiles are 0 when `count` is 0. */
export interface CompareSide {
  count: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
}

/** `after - before`. The percentile deltas are `null` when either side has no request. */
export interface CompareDelta {
  count: number;
  /** Difference of the error rates, as fractions (0.02 is two percentage points). */
  errorRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface RouteCompareRow {
  method: string;
  route: string;
  before: CompareSide;
  after: CompareSide;
  delta: CompareDelta;
}

export interface CompareRange {
  fromUnixMs: number;
  toUnixMs: number;
}

/** `GET api/v1/routes/compare` without releases: route statistics, counted before sampling. */
export interface RouteWindowCompareResponse {
  mode: "window";
  windowMinutes: number;
  /** `before` of every row. */
  previous: CompareRange;
  /** `after` of every row. */
  current: CompareRange;
  /** Whether statistics are kept for the whole previous window. */
  previousCovered: boolean;
  /** Why `previousCovered` is false, otherwise `null`. */
  note: string | null;
  /** Releases seen in the stored traces, for the release picker. */
  releases: string[];
  routes: RouteCompareRow[];
}

/** `GET api/v1/routes/compare?releaseA&releaseB`: built from the stored, sampled traces. */
export interface RouteReleaseCompareResponse {
  mode: "release";
  /** `before` of every row. */
  releaseA: string;
  /** `after` of every row. */
  releaseB: string;
  releases: string[];
  routes: RouteCompareRow[];
}

export type RouteCompareResponse =
  | RouteWindowCompareResponse
  | RouteReleaseCompareResponse;
