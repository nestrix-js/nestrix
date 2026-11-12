import type {
  Insight,
  InsightLink,
  OverviewResponse,
  OverviewStatusMix,
  OverviewTimeShare,
  OverviewTotals,
  RouteCompareRow,
} from "@nestrix-js/protocol";

import type { Tone } from "@/components/kit/format";
import { formatDuration } from "@/lib/format";

// The tone type and the donut and ring helpers live in the kit; these re-exports keep old imports working.
export {
  type DonutSlice,
  donutSlices,
  ringDasharray,
  type Tone,
} from "@/components/kit/format";

const MINUS = "−";
const DASH = "—";

/** "+41%", "−28%", "0%"; "—" when there is nothing to compare with. */
export function formatChange(change: number | null): string {
  if (change === null || !Number.isFinite(change)) return DASH;
  const percent = change * 100;
  const abs = Math.abs(percent);
  const text =
    abs < 10 ? abs.toFixed(1).replace(/\.0$/, "") : String(Math.round(abs));
  if (Number(text) === 0) return "0%";
  return `${percent > 0 ? "+" : MINUS}${text}%`;
}

/** `(after - before) / before`; `null` without a (non-zero) before. */
export function relativeChange(
  after: number,
  before: number | null | undefined,
): number | null {
  if (before === null || before === undefined || before === 0) return null;
  return (after - before) / before;
}

/** A difference of two fractions as percentage points: "+0.7 pt", "−1.2 pt"; "—" without both. */
export function formatPoints(delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return DASH;
  const points = delta * 100;
  const text = Math.abs(points).toFixed(1);
  if (Number(text) === 0) return "0 pt";
  return `${points > 0 ? "+" : MINUS}${text} pt`;
}

/** "+0.03", "−0.12", "0.00"; "—" without both. */
export function formatApdexDelta(delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return DASH;
  const text = Math.abs(delta).toFixed(2);
  if (Number(text) === 0) return "0.00";
  return `${delta > 0 ? "+" : MINUS}${text}`;
}

/** A fraction as a percentage with one decimal below 10%: "96.4%", "0.9%", "100%". */
export function formatShare(fraction: number): string {
  const percent = fraction * 100;
  if (percent >= 99.95) return "100%";
  return `${percent.toFixed(1)}%`;
}

/**
 * Whether a change is good or bad news. `badDirection` says which way hurts: `up` for latency and
 * errors, `down` for Apdex, `none` for throughput (more or fewer requests is not news by itself).
 * A change under `epsilon` is neutral.
 */
export function toneOf(
  delta: number | null,
  badDirection: "up" | "down" | "none",
  epsilon = 0.0005,
): Tone {
  if (delta === null || badDirection === "none" || Math.abs(delta) < epsilon)
    return "neutral";
  const up = delta > 0;
  return up === (badDirection === "up") ? "worse" : "better";
}

/** One KPI tile of the Overview. */
export interface Kpi {
  id: "throughput" | "errors" | "p95" | "apdex";
  label: string;
  value: string;
  unit: string;
  /** The change against the previous window, formatted; "—" when it is not known. */
  delta: string;
  tone: Tone;
  /** One value per bucket of the current window; empty for none. */
  series: number[];
  source: "stats" | "traces";
}

/** The four tiles that come from the response itself (the dependency tile has its own query). */
export function buildKpis(data: OverviewResponse): Kpi[] {
  const now = data.totals;
  const before = data.previousTotals;
  const bucketMinutes = data.bucketMs / 60_000;
  const perBucket = (pick: (p: OverviewResponse["series"][number]) => number) =>
    data.series.map(pick);
  return [
    {
      id: "throughput",
      label: "Throughput",
      value: formatRate(now.perMinute),
      unit: "req/min",
      delta: formatChange(
        before ? relativeChange(now.perMinute, before.perMinute) : null,
      ),
      tone: "neutral",
      series: perBucket((p) =>
        bucketMinutes > 0 ? p.count / bucketMinutes : p.count,
      ),
      source: "stats",
    },
    {
      id: "errors",
      label: "Error rate",
      value: formatErrorPercent(now.errorRate),
      unit: "%",
      delta: formatPoints(before ? now.errorRate - before.errorRate : null),
      tone: toneOf(before ? now.errorRate - before.errorRate : null, "up"),
      series: perBucket((p) => (p.count > 0 ? p.errors / p.count : 0)),
      source: "stats",
    },
    {
      id: "p95",
      label: "p95 latency",
      value: formatDuration(now.p95Ms).replace(/ (ms|s|min)$/, ""),
      unit: unitOf(now.p95Ms),
      delta: formatChange(
        before ? relativeChange(now.p95Ms, before.p95Ms) : null,
      ),
      tone: toneOf(
        before ? relativeChange(now.p95Ms, before.p95Ms) : null,
        "up",
        0.02,
      ),
      series: perBucket((p) => p.p95Ms ?? 0),
      source: "stats",
    },
    {
      id: "apdex",
      label: "Apdex",
      value: now.apdex === null ? DASH : now.apdex.toFixed(2),
      unit: "",
      delta: formatApdexDelta(
        before && now.apdex !== null && before.apdex !== null
          ? now.apdex - before.apdex
          : null,
      ),
      tone: toneOf(
        before && now.apdex !== null && before.apdex !== null
          ? now.apdex - before.apdex
          : null,
        "down",
        0.005,
      ),
      series: [],
      source: "stats",
    },
  ];
}

/** "1,284", "12.4", "0.3": a rate with the precision a small number needs. */
export function formatRate(perMinute: number): string {
  if (!Number.isFinite(perMinute)) return DASH;
  if (perMinute >= 100) return Math.round(perMinute).toLocaleString("en");
  if (perMinute >= 10) return perMinute.toFixed(1).replace(/\.0$/, "");
  return perMinute.toFixed(2).replace(/0$/, "").replace(/\.0$/, "");
}

/** The error rate as a percentage without its sign: "1.9", "0", "12". */
export function formatErrorPercent(rate: number): string {
  const percent = rate * 100;
  if (percent === 0) return "0";
  return percent < 10 ? percent.toFixed(1) : String(Math.round(percent));
}

/** The unit of `formatDuration`'s answer: "ms", "s" or "min". */
export function unitOf(ms: number): string {
  return formatDuration(ms).split(" ")[1] ?? "ms";
}

/** Satisfied, tolerating and frustrated shares of the Apdex bar, 0 to 1 each; all 0 without requests. */
export function apdexShares(totals: OverviewTotals): {
  satisfied: number;
  tolerating: number;
  frustrated: number;
} {
  const total = totals.satisfied + totals.tolerating + totals.frustrated;
  if (total <= 0) return { satisfied: 0, tolerating: 0, frustrated: 0 };
  return {
    satisfied: totals.satisfied / total,
    tolerating: totals.tolerating / total,
    frustrated: totals.frustrated / total,
  };
}

export const STATUS_PARTS: readonly {
  key: keyof OverviewStatusMix;
  label: string;
  color: string;
}[] = [
  { key: "ok", label: "Success (1xx, 2xx)", color: "--success" },
  { key: "redirect", label: "Redirect (3xx)", color: "--chart-5" },
  { key: "clientError", label: "Client error (4xx)", color: "--warning" },
  {
    key: "serverError",
    label: "Server error (5xx, thrown)",
    color: "--destructive",
  },
];

export const TIME_KINDS: Record<
  OverviewTimeShare["key"],
  { label: string; color: string }
> = {
  db: { label: "Database", color: "--chart-1" },
  "http-out": { label: "Outgoing HTTP", color: "--warning" },
  redis: { label: "Redis", color: "--chart-5" },
  messaging: { label: "Messaging", color: "--chart-4" },
  app: { label: "App code (Nest)", color: "--chart-2" },
  other: { label: "Other", color: "--muted-foreground" },
};

/** Change of a time share against the previous window, in points: "+12 pt"; "—" without one. */
export function formatShareChange(
  share: number,
  previousShare: number | null,
): string {
  return formatPoints(previousShare === null ? null : share - previousShare);
}

/** Where an insight leads: the target view's path and its search params. */
export function insightHref(link: InsightLink): string {
  const path: Record<InsightLink["view"], string> = {
    route: "/route",
    errors: "/errors",
    dependencies: "/dependencies",
    slos: "/slos",
  };
  const query = new URLSearchParams(link.params).toString();
  return query === "" ? path[link.view] : `${path[link.view]}?${query}`;
}

/** The change of an insight, for the right-hand column: its `change`, or "new" for a new thing. */
export function insightChange(insight: Insight): string {
  if (insight.before === null) return "new";
  return formatChange(insight.change);
}

export const SEVERITY_LABEL: Record<Insight["severity"], string> = {
  high: "High",
  medium: "Medium",
  low: "Better",
};

export const SOURCE_LABEL: Record<Insight["source"], string> = {
  stats: "before sampling",
  traces: "from sampled traces",
};

/**
 * Routes ranked by how much they changed: requests now times the size of the p95 change (at most
 * 10 times, as the API's insight impact). A route without requests in both windows has no change
 * and ranks by traffic alone, after every route that changed.
 */
export function rankRoutes(
  rows: readonly RouteCompareRow[],
): { row: RouteCompareRow; impact: number; change: number | null }[] {
  return rows
    .map((row) => {
      const change =
        row.before.count > 0 && row.after.count > 0
          ? relativeChange(row.after.p95Ms, row.before.p95Ms)
          : null;
      const impact =
        change === null ? 0 : row.after.count * Math.min(Math.abs(change), 10);
      return { row, impact, change };
    })
    .sort(
      (a, b) =>
        b.impact - a.impact ||
        b.row.after.count - a.row.after.count ||
        `${a.row.method} ${a.row.route}`.localeCompare(
          `${b.row.method} ${b.row.route}`,
        ),
    );
}

/** Whether the overview has any request to talk about. */
export const hasTraffic = (data: OverviewResponse): boolean =>
  data.totals.count > 0;
