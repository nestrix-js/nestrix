/**
 * The previous window (the same length, just before the current one) for the classes,
 * dependencies and map answers (P15-01). Pure merges: the service runs the same query twice, the
 * second with `now` at the last millisecond before the current window, and these functions put
 * the second answer's numbers next to the first's.
 */
import type {
  AppMapPreviousTotals,
  AppMapResponse,
  ClassStatsPreviousTotals,
  ClassStatsResponse,
  DependenciesResponse,
  DependencyPreviousTotals,
  MapEdge,
} from "@nestrix-js/protocol";

export const NOT_COVERED_NOTE =
  "Statistics start less than two windows ago, so the previous window is only partly counted or empty.";

const round = (ms: number): number => Math.round(ms * 1000) / 1000;

/** The answer when the previous window is not covered: nothing else is added. */
export function uncovered<T extends object>(
  current: T,
): T & { previousCovered: false; note: string } {
  return { ...current, previousCovered: false, note: NOT_COVERED_NOTE };
}

export function withPreviousDependencies(
  current: DependenciesResponse,
  previous: DependenciesResponse,
): DependenciesResponse {
  const byId = new Map(previous.dependencies.map((d) => [d.id, d]));
  const totals: DependencyPreviousTotals = {
    dependencies: previous.dependencies.length,
    calls: 0,
    errors: 0,
    slowestP95Ms: 0,
  };
  for (const d of previous.dependencies) {
    totals.calls += d.calls;
    totals.errors += d.errors;
    if (d.p95Ms > totals.slowestP95Ms) totals.slowestP95Ms = d.p95Ms;
  }
  return {
    ...current,
    dependencies: current.dependencies.map((d) => {
      const p = byId.get(d.id);
      return p === undefined
        ? d
        : {
            ...d,
            previous: {
              calls: p.calls,
              errors: p.errors,
              errorRate: p.errorRate,
              totalMs: p.totalMs,
              p50Ms: p.p50Ms,
              p95Ms: p.p95Ms,
            },
          };
    }),
    previousCovered: true,
    note: null,
    previousTotals: totals,
  };
}

export function withPreviousClasses(
  current: ClassStatsResponse,
  previous: ClassStatsResponse,
): ClassStatsResponse {
  const byName = new Map(previous.classes.map((c) => [c.className, c]));
  const totals: ClassStatsPreviousTotals = {
    classes: previous.classes.length,
    calls: 0,
    errors: 0,
    totalMs: 0,
    ownMs: null,
  };
  for (const c of previous.classes) {
    totals.calls += c.calls;
    totals.errors += c.errors;
    totals.totalMs += c.totalMs;
    if (c.ownMs !== null) totals.ownMs = (totals.ownMs ?? 0) + c.ownMs;
  }
  totals.totalMs = round(totals.totalMs);
  if (totals.ownMs !== null) totals.ownMs = round(totals.ownMs);
  return {
    ...current,
    classes: current.classes.map((c) => {
      const p = byName.get(c.className);
      return p === undefined
        ? c
        : {
            ...c,
            previous: {
              calls: p.calls,
              errors: p.errors,
              totalMs: p.totalMs,
              avgMs: p.avgMs,
              ownMs: p.ownMs,
            },
          };
    }),
    previousCovered: true,
    note: null,
    previousTotals: totals,
  };
}

export function withPreviousMap(
  current: AppMapResponse,
  previous: AppMapResponse,
): AppMapResponse {
  const apps = new Set(
    previous.nodes.filter((n) => n.kind === "app").map((n) => n.id),
  );
  const key = (e: MapEdge) => `${e.from}\u0000${e.to}`;
  const byKey = new Map(previous.edges.map((e) => [key(e), e]));
  const totals: AppMapPreviousTotals = {
    targets: new Set(
      previous.edges.filter((e) => !apps.has(e.to)).map((e) => e.to),
    ).size,
    calls: 0,
    errors: 0,
    slowestP95Ms: 0,
  };
  for (const e of previous.edges) {
    totals.calls += e.calls;
    totals.errors += e.errors;
    if (e.p95Ms > totals.slowestP95Ms) totals.slowestP95Ms = e.p95Ms;
  }
  return {
    ...current,
    edges: current.edges.map((e) => {
      const p = byKey.get(key(e));
      return p === undefined
        ? e
        : {
            ...e,
            previous: {
              calls: p.calls,
              errors: p.errors,
              p50Ms: p.p50Ms,
              p95Ms: p.p95Ms,
            },
          };
    }),
    previousCovered: true,
    note: null,
    previousTotals: totals,
  };
}
