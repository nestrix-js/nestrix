import type { DependencyStats } from "@nestrix-js/protocol";

import type { ChipTone } from "@/components/kit/format";

export type Health = "healthy" | "degraded" | "failing";

/** A dependency fails at this error rate (a fraction) or more. */
export const FAILING_ERROR_RATE = 0.05;
/** It is degraded from this error rate, or from this p95 (ms), whichever it reaches first. */
export const DEGRADED_ERROR_RATE = 0.01;
export const DEGRADED_P95_MS = 1000;

/**
 * The status shown on a dependency's card, from the window's error rate and p95 only: failing at
 * 5% errors or more, degraded at 1% errors or a p95 of one second, otherwise healthy.
 */
export function dependencyHealth(
  d: Pick<DependencyStats, "errorRate" | "p95Ms">,
): Health {
  if (d.errorRate >= FAILING_ERROR_RATE) return "failing";
  if (d.errorRate >= DEGRADED_ERROR_RATE || d.p95Ms >= DEGRADED_P95_MS) {
    return "degraded";
  }
  return "healthy";
}

export const healthLabel: Record<Health, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  failing: "Failing",
};

export const healthTone: Record<Health, ChipTone> = {
  healthy: "better",
  degraded: "warn",
  failing: "worse",
};

/** `0%`, `5.0%`, `12%`: an error rate as a percentage. */
export function formatErrorRate(
  d: Pick<DependencyStats, "errors" | "errorRate">,
) {
  return d.errors === 0
    ? "0%"
    : `${(d.errorRate * 100).toFixed(d.errorRate < 0.1 ? 1 : 0)}%`;
}

/** One series of the stacked calls chart. */
export interface CallsSeries {
  id: string;
  label: string;
  values: number[];
}

/**
 * Calls per bucket for the `top` dependencies (the list's order: most total time first) and one
 * more series, "Other", with the rest summed; none when nothing was called.
 */
export function callsSeries(
  deps: readonly Pick<DependencyStats, "id" | "name" | "series">[],
  top: number,
): CallsSeries[] {
  const buckets = Math.max(0, ...deps.map((d) => d.series.length));
  const calls = (d: Pick<DependencyStats, "series">) =>
    Array.from({ length: buckets }, (_, i) => d.series[i]?.calls ?? 0);
  const shown = deps.slice(0, top).map((d) => ({
    id: d.id,
    label: d.name,
    values: calls(d),
  }));
  const rest = deps.slice(top);
  const out = [...shown];
  if (rest.length > 0) {
    const sums = Array.from({ length: buckets }, () => 0);
    for (const d of rest) {
      const c = calls(d);
      for (let i = 0; i < buckets; i++) sums[i] = (sums[i] ?? 0) + (c[i] ?? 0);
    }
    out.push({ id: "other", label: `Other (${rest.length})`, values: sums });
  }
  return out.some((s) => s.values.some((v) => v > 0)) ? out : [];
}
