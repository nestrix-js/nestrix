// A `routes/histogram` answer for the route detail tests: most requests fast, a slow tail.
import type { RouteHistogramResponse } from "@nestrix-js/protocol";

const BOUNDS = Array.from({ length: 29 }, (_, i) => 60_000 ** (i / 28));
const COUNTS: Record<number, number> = {
  8: 30,
  10: 80,
  12: 120,
  14: 90,
  16: 50,
  18: 20,
  20: 9,
  22: 4,
};

export function histogramFor(q: URLSearchParams): RouteHistogramResponse {
  return {
    method: q.get("method"),
    route: q.get("route") ?? "",
    windowMinutes: Number(q.get("windowMinutes") ?? 15),
    fromUnixMs: 0,
    toUnixMs: 0,
    count: Object.values(COUNTS).reduce((a, b) => a + b, 0),
    p50Ms: 142,
    p95Ms: 680,
    p99Ms: 1900,
    maxMs: 4800,
    buckets: Array.from({ length: 30 }, (_, i) => ({
      fromMs: i === 0 ? 0 : (BOUNDS[i - 1] as number),
      toMs: i === 29 ? null : (BOUNDS[i] as number),
      count: COUNTS[i] ?? 0,
    })),
  };
}
