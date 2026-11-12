import type { AppMapResponse, MapEdge } from "@nestrix-js/protocol";

import {
  countChange,
  msChange,
  rateChange,
  rateOf,
  unknownChange,
  whyNoPrevious,
} from "@/views/previous-window";
import type { Change } from "@/views/routes/route-kpis";

export interface MapChanges {
  /** Targets called by the app; services are not compared. */
  targets: Change;
  calls: Change;
  errorRate: Change;
  slowest: Change;
}

/**
 * The tiles' changes against the previous window, from the answer's `previousTotals` (every edge,
 * including ones with no calls now). `edges` are the ones the tiles total. Every one is "—" when
 * the previous window is not covered.
 */
export function mapChanges(
  data: AppMapResponse | undefined,
  edges: readonly MapEdge[],
  targets: number,
): MapChanges {
  const reason = whyNoPrevious(data);
  const before = data?.previousTotals;
  if (reason !== null || before === undefined) {
    const none = unknownChange(reason ?? "The previous window has no totals.");
    return { targets: none, calls: none, errorRate: none, slowest: none };
  }
  const calls = edges.reduce((n, e) => n + e.calls, 0);
  const errors = edges.reduce((n, e) => n + e.errors, 0);
  const slowest = edges.reduce((m, e) => Math.max(m, e.p95Ms), 0);
  return {
    targets: countChange(before.targets, targets, "calls to targets"),
    calls: countChange(before.calls, calls, "calls"),
    errorRate: rateChange(
      rateOf(before.errors, before.calls),
      rateOf(errors, calls),
    ),
    slowest: msChange(before.slowestP95Ms, slowest),
  };
}

/** The p95 change of one edge; "new" when it had no calls in the previous window. */
export function edgeP95Change(
  e: MapEdge,
  data: AppMapResponse | undefined,
): Change {
  const reason = whyNoPrevious(data);
  if (reason !== null) return unknownChange(reason);
  if (e.previous === undefined)
    return {
      text: "new",
      tone: "neutral",
      title: "No calls in the previous window",
    };
  return msChange(e.previous.p95Ms, e.p95Ms);
}
