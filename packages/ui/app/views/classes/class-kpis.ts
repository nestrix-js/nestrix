import type { ClassKind, ClassStats } from "@nestrix-js/protocol";

/** The groups the donut shows: the API's kinds, with guard, pipe, interceptor and filter together. */
export type KindGroup =
  | "controller"
  | "service"
  | "repository"
  | "pipeline"
  | "processor"
  | "other";

export const KIND_GROUPS: readonly {
  key: KindGroup;
  label: string;
  /** A CSS custom property from the chart palette. */
  color: string;
}[] = [
  { key: "controller", label: "Controllers", color: "--chart-1" },
  { key: "service", label: "Services", color: "--chart-2" },
  { key: "repository", label: "Repositories", color: "--chart-4" },
  {
    key: "pipeline",
    label: "Guards, pipes, interceptors and filters",
    color: "--chart-5",
  },
  { key: "processor", label: "Processors", color: "--warning" },
  { key: "other", label: "Other providers", color: "--muted-foreground" },
];

export function kindGroup(kind: ClassKind): KindGroup {
  switch (kind) {
    case "controller":
    case "service":
    case "repository":
    case "processor":
      return kind;
    case "guard":
    case "pipe":
    case "interceptor":
    case "filter":
      return "pipeline";
    default:
      return "other";
  }
}

export interface KindShare {
  key: KindGroup;
  label: string;
  color: string;
  value: number;
}

/**
 * Time per group of class kinds, for the donut. Own time (duration minus child spans) when any
 * class has an estimate, because it does not count the same time twice; otherwise total time.
 * `basis` says which one was used. Groups without time are left out.
 */
export function kindBreakdown(classes: readonly ClassStats[]): {
  basis: "own" | "total";
  shares: KindShare[];
  sum: number;
} {
  const basis = classes.some((c) => (c.ownMs ?? 0) > 0) ? "own" : "total";
  const value = (c: ClassStats) =>
    basis === "own" ? (c.ownMs ?? 0) : c.totalMs;
  const shares = KIND_GROUPS.map((g) => ({
    ...g,
    value: classes
      .filter((c) => kindGroup(c.kind) === g.key)
      .reduce((sum, c) => sum + Math.max(0, value(c)), 0),
  })).filter((s) => s.value > 0);
  return { basis, shares, sum: shares.reduce((n, s) => n + s.value, 0) };
}

export interface ClassSummary {
  classes: number;
  calls: number;
  errors: number;
  /** Errors over calls as a fraction; null without calls. */
  errorRate: number | null;
  totalMs: number;
  /** Null when no class has an own-time estimate. */
  ownMs: number | null;
  /** The class with the most own time (or total time without estimates); null without classes. */
  heaviest: ClassStats | null;
}

export function summarizeClasses(classes: readonly ClassStats[]): ClassSummary {
  const calls = classes.reduce((n, c) => n + c.calls, 0);
  const errors = classes.reduce((n, c) => n + c.errors, 0);
  const estimated = classes.filter((c) => c.ownMs !== null);
  const ownMs =
    estimated.length === 0
      ? null
      : estimated.reduce((n, c) => n + (c.ownMs ?? 0), 0);
  const weight = (c: ClassStats) =>
    ownMs === null ? c.totalMs : (c.ownMs ?? 0);
  const heaviest =
    [...classes].sort(
      (a, b) => weight(b) - weight(a) || a.className.localeCompare(b.className),
    )[0] ?? null;
  return {
    classes: classes.length,
    calls,
    errors,
    errorRate: calls > 0 ? errors / calls : null,
    totalMs: classes.reduce((n, c) => n + c.totalMs, 0),
    ownMs,
    heaviest,
  };
}

/** "34%" of a total, "<1%" for a sliver, "-" without a total. */
export function formatShare(value: number, sum: number): string {
  if (sum <= 0) return "-";
  const percent = (value / sum) * 100;
  return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}
