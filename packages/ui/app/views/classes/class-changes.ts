import type { ClassStats, ClassStatsResponse } from "@nestrix-js/protocol";

import type { ClassSummary } from "@/views/classes/class-kpis";
import {
  countChange,
  msChange,
  rateChange,
  rateOf,
  unknownChange,
  whyNoPrevious,
} from "@/views/previous-window";
import type { Change } from "@/views/routes/route-kpis";

export interface ClassChanges {
  classes: Change;
  calls: Change;
  errorRate: Change;
  own: Change;
}

/**
 * The tiles' changes against the previous window, from the answer's `previousTotals` (every
 * class, including ones with no calls now). `summary` is of the same classes the tiles show.
 * Every one is "—" when the previous window is not covered.
 */
export function classChanges(
  data: ClassStatsResponse | undefined,
  summary: ClassSummary,
): ClassChanges {
  const reason = whyNoPrevious(data);
  const before = data?.previousTotals;
  if (reason !== null || before === undefined) {
    const none = unknownChange(reason ?? "The previous window has no totals.");
    return { classes: none, calls: none, errorRate: none, own: none };
  }
  return {
    classes: countChange(before.classes, summary.classes, "classes"),
    calls: countChange(before.calls, summary.calls, "calls"),
    errorRate: rateChange(
      rateOf(before.errors, before.calls),
      summary.errorRate,
    ),
    own: msChange(before.ownMs, summary.ownMs),
  };
}

/** The average-time change of one class; "new" when it had no calls in the previous window. */
export function rowAvgChange(
  c: ClassStats,
  data: ClassStatsResponse | undefined,
): Change {
  const reason = whyNoPrevious(data);
  if (reason !== null) return unknownChange(reason);
  if (c.previous === undefined)
    return {
      text: "new",
      tone: "neutral",
      title: "No calls in the previous window",
    };
  return msChange(c.previous.avgMs, c.avgMs);
}
