import type {
  RouteCompareResponse,
  RouteCompareRow,
  RouteStats,
} from "@nestrix-js/protocol";

import type { Tone } from "@/components/kit/format";
import {
  formatDeltaMs,
  formatDeltaRate,
  verdictOf,
} from "@/views/routes/route-insights";
import { routeKey } from "@/views/routes/route-stats";

/** What the KPI strip shows, from the routes of one window. */
export interface RouteSummary {
  routes: number;
  requests: number;
  requestsPerMinute: number;
  errors: number;
  /** Errors over requests as a fraction; null without requests. */
  errorRate: number | null;
  /** The route with the highest p95 among those that had requests; null without any. */
  worst: RouteStats | null;
  /** Requests and errors per bucket, summed over every route. */
  requestSeries: number[];
  errorSeries: number[];
}

function sumSeries(
  routes: readonly RouteStats[],
  pick: (p: RouteStats["series"][number]) => number,
): number[] {
  const out: number[] = [];
  for (const route of routes)
    route.series.forEach((point, i) => {
      out[i] = (out[i] ?? 0) + pick(point);
    });
  return out;
}

/** Highest p95 first; ties by key so the choice is stable between polls. */
function byP95(a: RouteStats, b: RouteStats): number {
  return b.p95Ms - a.p95Ms || routeKey(a).localeCompare(routeKey(b));
}

export function summarizeRoutes(
  routes: readonly RouteStats[],
  windowMinutes: number,
): RouteSummary {
  const requests = routes.reduce((n, r) => n + r.count, 0);
  const errors = routes.reduce((n, r) => n + r.errors, 0);
  const worst = routes.filter((r) => r.count > 0).sort(byP95)[0] ?? null;
  return {
    routes: routes.length,
    requests,
    requestsPerMinute: windowMinutes > 0 ? requests / windowMinutes : 0,
    errors,
    errorRate: requests > 0 ? errors / requests : null,
    worst,
    requestSeries: sumSeries(routes, (p) => p.count),
    errorSeries: sumSeries(routes, (p) => p.errors),
  };
}

/** The `limit` routes with the highest p95, slowest first; routes without requests are left out. */
export function topByP95(
  routes: readonly RouteStats[],
  limit = 8,
): RouteStats[] {
  return routes
    .filter((r) => r.count > 0)
    .sort(byP95)
    .slice(0, limit);
}

/** "0.4", "12.6" becomes "13": one decimal under 10, none above. */
export function formatPerMinute(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

/** "+12%", "-3.5%"; null when the earlier figure is 0 (no base to compare with). */
export function formatChangePercent(
  before: number,
  after: number,
): string | null {
  if (before <= 0) return null;
  const percent = ((after - before) / before) * 100;
  if (percent === 0) return "0%";
  const shown =
    Math.abs(percent) < 10 ? percent.toFixed(1) : percent.toFixed(0);
  return `${percent > 0 ? "+" : ""}${shown}%`;
}

export interface Change {
  text: string;
  tone: Tone;
  title?: string;
}

const UNKNOWN = "—";
const unknown = (title: string): Change => ({
  text: UNKNOWN,
  tone: "neutral",
  title,
});

/** Why there is no change to show, or null when the previous window is covered. */
export function noPreviousReason(
  compare: RouteCompareResponse | undefined,
): string | null {
  if (compare === undefined) return "The previous window has not loaded.";
  if (compare.mode !== "window") return "No previous window to compare with.";
  if (!compare.previousCovered)
    return compare.note ?? "Statistics do not cover the previous window.";
  return null;
}

const toneOfSign = (n: number): Tone =>
  n > 0 ? "worse" : n < 0 ? "better" : "neutral";

export interface WindowChanges {
  requests: Change;
  errorRate: Change;
  worstP95: Change;
}

/**
 * The strip's changes against the previous window, from `routes/compare`: requests as a
 * percentage (neither good nor bad), the error rate in points and the worst p95 in ms (higher is
 * worse). Every one is "—" when the API has no covered previous window.
 */
export function windowChanges(
  compare: RouteCompareResponse | undefined,
): WindowChanges {
  const reason = noPreviousReason(compare);
  if (reason !== null || compare === undefined || compare.mode !== "window")
    return {
      requests: unknown(reason ?? ""),
      errorRate: unknown(reason ?? ""),
      worstP95: unknown(reason ?? ""),
    };
  const rows = compare.routes;
  type Side = "before" | "after";
  const sum = (side: Side, key: "count" | "errors") =>
    rows.reduce((n, r) => n + r[side][key], 0);
  const requests = formatChangePercent(
    sum("before", "count"),
    sum("after", "count"),
  );
  const rate = (side: Side) => {
    const count = sum(side, "count");
    return count > 0 ? sum(side, "errors") / count : null;
  };
  const worst = (side: Side) =>
    rows.reduce(
      (m, r) => (r[side].count > 0 ? Math.max(m, r[side].p95Ms) : m),
      0,
    );
  const rateBefore = rate("before");
  const rateAfter = rate("after");
  const p95Before = worst("before");
  const p95After = worst("after");
  return {
    requests:
      requests === null
        ? unknown("No requests in the previous window.")
        : { text: requests, tone: "neutral" },
    errorRate:
      rateBefore === null || rateAfter === null
        ? unknown("No requests in one of the windows.")
        : {
            text: formatDeltaRate(rateAfter - rateBefore),
            tone: toneOfSign(rateAfter - rateBefore),
          },
    worstP95:
      p95Before === 0 || p95After === 0
        ? unknown("No requests in one of the windows.")
        : {
            text: formatDeltaMs(p95After - p95Before),
            tone: toneOfSign(p95After - p95Before),
          },
  };
}

/** The p95 change of one route against the previous window; "—" without a row or a delta. */
export function rowChange(row: RouteCompareRow | undefined): Change {
  if (row === undefined || row.delta.p95Ms === null)
    return unknown("No p95 in one of the windows.");
  const verdict = verdictOf(row);
  return {
    text: formatDeltaMs(row.delta.p95Ms),
    tone:
      verdict === "regression"
        ? "worse"
        : verdict === "improvement"
          ? "better"
          : "neutral",
    title:
      verdict === "regression"
        ? "A regression: p95 or the error rate rose"
        : verdict === "improvement"
          ? "An improvement"
          : "No meaningful change",
  };
}

/** Compare rows by route key, for the table's change column. */
export function compareByKey(
  compare: RouteCompareResponse | undefined,
): Map<string, RouteCompareRow> {
  const map = new Map<string, RouteCompareRow>();
  if (compare?.mode === "window")
    for (const row of compare.routes) map.set(routeKey(row), row);
  return map;
}
