/**
 * SLO arithmetic over summed `route_minutes` (docs/backlog/phase-7.md, P7-04). Pure: the database
 * reads are in `service.ts` and `alerts/metrics.ts`.
 *
 * Definitions, for a period with `count` requests:
 *
 * - availability: bad = `errors`, the rollup's definition (span status error, or an HTTP 5xx; a
 *   thrown 4xx is not an error). good = count - errors.
 * - latency: good = requests faster than the threshold, estimated from the rollup histogram: the
 *   buckets whose upper bound is at or below the threshold count in full, the bucket that holds
 *   the threshold counts in proportion to where the threshold falls inside it (linear
 *   interpolation, the same assumption as `estimateQuantile`; the last bucket is bounded by the
 *   period's largest duration). bad = count - good.
 * - attainment = good / count; budget total = (1 - objective) * count; remaining = total - bad.
 * - burn rate over a period = (bad / count) / (1 - objective): 1 spends the budget exactly at the
 *   rate the objective allows.
 *
 * Sums are over the SLO's window ending now, the current partial minute included.
 */
import type { SloStatus } from "@nestrix/protocol";
import {
  HISTOGRAM_BUCKETS,
  HISTOGRAM_UPPER_BOUNDS_MS,
} from "../storage/histogram.js";

/** `SELECT * FROM slos` as pg returns it (bigint as string). */
export interface SloRow {
  id: string;
  name: string;
  service_name: string;
  route: string | null;
  kind: "availability" | "latency";
  latency_threshold_ms: number | null;
  objective: number;
  window_days: 7 | 30;
  created_at: Date;
  updated_at: Date;
}

export interface Totals {
  count: number;
  errors: number;
  maxMs: number;
  hist: number[];
}

/** Requests faster than `thresholdMs`, estimated from the histogram (see the file comment). */
export function goodUnderThreshold(
  hist: readonly number[],
  thresholdMs: number,
  maxMs: number,
): number {
  let good = 0;
  for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
    const n = hist[i] ?? 0;
    if (n === 0) continue;
    const lo = i === 0 ? 0 : (HISTOGRAM_UPPER_BOUNDS_MS[i - 1] as number);
    const hi =
      i === HISTOGRAM_BUCKETS - 1
        ? Math.max(maxMs, lo)
        : (HISTOGRAM_UPPER_BOUNDS_MS[i] as number);
    if (thresholdMs >= hi) good += n;
    else if (thresholdMs > lo) good += n * ((thresholdMs - lo) / (hi - lo));
  }
  return good;
}

/** Bad requests of the period (never more than `count`). */
export function badRequests(
  slo: Pick<SloRow, "kind" | "latency_threshold_ms">,
  t: Totals,
): number {
  if (t.count <= 0) return 0;
  if (slo.kind === "availability") return Math.min(t.errors, t.count);
  const good = goodUnderThreshold(
    t.hist,
    slo.latency_threshold_ms ?? 0,
    t.maxMs,
  );
  return Math.max(0, t.count - Math.min(good, t.count));
}

/** Bad share of the period's requests; 0 without requests. */
export function badFraction(
  slo: Pick<SloRow, "kind" | "latency_threshold_ms">,
  t: Totals,
): number {
  return t.count > 0 ? badRequests(slo, t) / t.count : 0;
}

/** Burn rate of a period, or `null` without requests. */
export function burnRate(
  slo: Pick<SloRow, "kind" | "latency_threshold_ms" | "objective">,
  t: Totals,
): number | null {
  if (t.count <= 0) return null;
  return badFraction(slo, t) / (1 - slo.objective);
}

/** The status over the SLO's window, with the 1 h and 6 h periods for the burn rates. */
export function computeStatus(
  slo: Pick<SloRow, "kind" | "latency_threshold_ms" | "objective">,
  window: Totals,
  hour1: Totals,
  hours6: Totals,
): SloStatus {
  const total = window.count;
  const bad = badRequests(slo, window);
  const budget = (1 - slo.objective) * total;
  const attainment = total > 0 ? (total - bad) / total : null;
  return {
    totalRequests: total,
    goodRequests: total - bad,
    badRequests: bad,
    attainment,
    errorBudget: {
      totalRequests: budget,
      remainingRequests: budget - bad,
      remainingFraction: total > 0 ? (budget - bad) / budget : null,
    },
    burnRate: { "1h": burnRate(slo, hour1), "6h": burnRate(slo, hours6) },
    breached: attainment !== null && attainment < slo.objective,
  };
}
