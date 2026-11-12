import type {
  DependenciesResponse,
  DependencyPreviousTotals,
  DependencyStats,
} from "@nestrix-js/protocol";

import {
  countChange,
  msChange,
  rateChange,
  rateOf,
  unknownChange,
  whyNoPrevious,
} from "@/views/previous-window";
import type { Change } from "@/views/routes/route-kpis";

export interface DependencyChanges {
  dependencies: Change;
  calls: Change;
  errorRate: Change;
  slowest: Change;
}

/** The previous window's totals over the rows on screen (a name filter narrows them). */
function previousOf(
  rows: readonly DependencyStats[],
): DependencyPreviousTotals {
  const totals: DependencyPreviousTotals = {
    dependencies: 0,
    calls: 0,
    errors: 0,
    slowestP95Ms: 0,
  };
  for (const d of rows) {
    if (d.previous === undefined) continue;
    totals.dependencies++;
    totals.calls += d.previous.calls;
    totals.errors += d.previous.errors;
    totals.slowestP95Ms = Math.max(totals.slowestP95Ms, d.previous.p95Ms);
  }
  return totals;
}

/**
 * The tiles' changes against the previous window. `rows` is what the page shows; `filtered` says a
 * name filter narrowed it, so the answer's totals (which cover every target) do not apply and the
 * rows' own `previous` are summed instead. Every one is "—" when the previous window is not covered.
 */
export function dependencyChanges(
  data: DependenciesResponse | undefined,
  rows: readonly DependencyStats[],
  filtered: boolean,
): DependencyChanges {
  const reason = whyNoPrevious(data);
  const before = filtered ? previousOf(rows) : data?.previousTotals;
  if (reason !== null || before === undefined) {
    const none = unknownChange(reason ?? "The previous window has no totals.");
    return { dependencies: none, calls: none, errorRate: none, slowest: none };
  }
  const calls = rows.reduce((n, d) => n + d.calls, 0);
  const errors = rows.reduce((n, d) => n + d.errors, 0);
  const slowest = rows.reduce((m, d) => Math.max(m, d.p95Ms), 0);
  return {
    dependencies: countChange(before.dependencies, rows.length, "dependencies"),
    calls: countChange(before.calls, calls, "calls"),
    errorRate: rateChange(
      rateOf(before.errors, before.calls),
      rateOf(errors, calls),
    ),
    slowest: msChange(before.slowestP95Ms, slowest),
  };
}

/** The p95 change of one dependency; "new" when it had no calls in the previous window. */
export function rowP95Change(
  d: DependencyStats,
  data: DependenciesResponse | undefined,
): Change {
  const reason = whyNoPrevious(data);
  if (reason !== null) return unknownChange(reason);
  if (d.previous === undefined)
    return {
      text: "new",
      tone: "neutral",
      title: "No calls in the previous window",
    };
  return msChange(d.previous.p95Ms, d.p95Ms);
}
