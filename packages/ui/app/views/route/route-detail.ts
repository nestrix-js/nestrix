import type {
  ExplainFinding,
  ExplainKindRow,
  ExplainSideInfo,
  RouteCompareRow,
  RouteExplainResponse,
  RouteStats,
} from "@nestrix-js/protocol";

import type { QueryParams } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import {
  formatChange,
  formatErrorPercent,
  formatPoints,
  formatRate,
  relativeChange,
  TIME_KINDS,
  type Tone,
  toneOf,
} from "@/views/overview/overview-format";
import { formatDeltaMs } from "@/views/routes/route-insights";

/** The route detail page for one route (`method` absent: every method of it). */
export function routeDetailHref(
  method: string | null | undefined,
  route: string,
): string {
  const params = new URLSearchParams();
  if (method !== null && method !== undefined && method !== "*")
    params.set("method", method);
  params.set("route", route);
  return `/route?${params.toString()}`;
}

/** Fewer traces than this on a side and the API makes no findings (docs/backlog/phase-12.md). */
export const MIN_TRACES = 5;

/** A side with too few traces to say anything: the tables show, the findings do not. */
export const tooFewTraces = (data: RouteExplainResponse): boolean =>
  data.before.traces < MIN_TRACES || data.after.traces < MIN_TRACES;

/** Neither side has a trace: an unknown route, or one with no sampled traces in these sides. */
export const noTraces = (data: RouteExplainResponse): boolean =>
  data.before.traces === 0 && data.after.traces === 0;

/**
 * Where a finding leads, with the filter its `link.params` name and the target page reads:
 * Queries `q` (and `nplus` for an N+1), Dependencies `name`, Classes `class`, Errors `route` and
 * `type` (the view that lists every occurrence).
 */
export function findingHref(
  finding: Pick<ExplainFinding, "kind" | "link">,
  windowMinutes: number,
): string | null {
  const link = finding.link;
  if (link === null) return null;
  const params = new URLSearchParams();
  const pass = (key: string, from = key, max = 512) => {
    const value = link.params[from];
    if (value !== undefined && value !== "")
      params.set(key, value.slice(0, max));
  };
  if (link.view === "errors") {
    params.set("view", "all");
    pass("route");
    pass("type");
  } else {
    params.set("windowMinutes", String(windowMinutes));
    if (link.view === "queries") {
      pass("q", "q", 120);
      if (finding.kind === "n-plus-one") params.set("nplus", "true");
    }
    if (link.view === "dependencies") pass("name");
    if (link.view === "classes") pass("class");
  }
  return `/${link.view}?${params.toString()}`;
}

export const FINDING_LINK_LABEL: Record<
  NonNullable<ExplainFinding["link"]>["view"],
  string
> = {
  queries: "Open Queries",
  dependencies: "Open Dependencies",
  classes: "Open Classes",
  errors: "Open the errors",
};

/** "6.4", "3", "0.4": calls per request with one decimal, none when whole. */
export function formatCalls(calls: number): string {
  if (!Number.isFinite(calls)) return "—";
  return calls.toFixed(1).replace(/\.0$/, "");
}

/** "+6.4", "−2", "0": a change of calls per request. */
export function formatCallsDelta(before: number, after: number): string {
  const delta = after - before;
  const text = Math.abs(delta).toFixed(1).replace(/\.0$/, "");
  if (text === "0") return "0";
  return `${delta > 0 ? "+" : "−"}${text}`;
}

/** "+214 ms", "−3.4 ms", "0 ms". */
export function formatMsDelta(before: number, after: number): string {
  const delta = after - before;
  if (Math.abs(delta) < 0.05) return "0 ms";
  return formatDeltaMs(delta).replace("-", "−");
}

/** More time is worse; a change under half a millisecond is not news. */
export const msTone = (before: number, after: number): Tone =>
  toneOf(after - before, "up", 0.5);

/** More calls per request is worse (an N+1 shows as calls first). */
export const callsTone = (before: number, after: number): Tone =>
  toneOf(after - before, "up", 0.05);

/** A failure rate that went up is worse; shown in points. */
export function formatRateDelta(
  before: number | null,
  after: number | null,
): string {
  return before === null || after === null ? "—" : formatPoints(after - before);
}
export const rateTone = (before: number | null, after: number | null): Tone =>
  before === null || after === null
    ? "neutral"
    : toneOf(after - before, "up", 0.001);

/** "3.2%", "0%", "—" for a rate nobody has. */
export function formatRateOrDash(rate: number | null): string {
  if (rate === null) return "—";
  const text = formatErrorPercent(rate);
  return `${text}%`;
}

/** Mean calls of every database statement per request on each side. */
export function queriesPerRequest(data: RouteExplainResponse): {
  before: number;
  after: number;
} {
  let before = 0;
  let after = 0;
  for (const s of data.statements) {
    before += s.beforeCalls;
    after += s.afterCalls;
  }
  return { before, after };
}

export interface RouteKpi {
  id: string;
  label: string;
  value: string;
  delta: string;
  tone: Tone;
  was: string;
  source: "stats" | "traces";
}

/** The explain response's KPI that every mode has. */
function queriesKpi(data: RouteExplainResponse): RouteKpi {
  const q = queriesPerRequest(data);
  const has = data.statements.length > 0;
  return {
    id: "queries",
    label: "Queries per request",
    value: has ? formatCalls(q.after) : "—",
    delta: has ? formatCallsDelta(q.before, q.after) : "—",
    tone: has ? callsTone(q.before, q.after) : "neutral",
    was: has ? formatCalls(q.before) : "—",
    source: "traces",
  };
}

/**
 * Window mode: requests per minute, p95, p99 and error rate from the route statistics (counted
 * before sampling), changes from the window comparison. The comparison has no p99, so that tile
 * has no change.
 */
export function windowKpis(
  stats: Pick<RouteStats, "count" | "errors" | "p95Ms" | "p99Ms"> | undefined,
  row: RouteCompareRow | undefined,
  covered: boolean,
  windowMinutes: number,
  data: RouteExplainResponse,
): RouteKpi[] {
  const compare = covered && row !== undefined && row.before.count > 0;
  const rate = stats ? stats.count / windowMinutes : null;
  const errorRate =
    stats && stats.count > 0 ? stats.errors / stats.count : null;
  const beforeErrorRate =
    row && row.before.count > 0 ? row.before.errors / row.before.count : null;
  return [
    {
      id: "throughput",
      label: "Requests per minute",
      value: rate === null ? "—" : formatRate(rate),
      delta:
        compare && row
          ? formatChange(relativeChange(row.after.count, row.before.count))
          : "—",
      tone: "neutral",
      was: compare && row ? formatRate(row.before.count / windowMinutes) : "—",
      source: "stats",
    },
    {
      id: "p95",
      label: "p95",
      value: stats ? formatDuration(stats.p95Ms) : "—",
      delta:
        compare && row
          ? formatChange(relativeChange(row.after.p95Ms, row.before.p95Ms))
          : "—",
      tone:
        compare && row
          ? toneOf(
              relativeChange(row.after.p95Ms, row.before.p95Ms),
              "up",
              0.02,
            )
          : "neutral",
      was: compare && row ? formatDuration(row.before.p95Ms) : "—",
      source: "stats",
    },
    {
      id: "p99",
      label: "p99",
      value: stats ? formatDuration(stats.p99Ms) : "—",
      delta: "—",
      tone: "neutral",
      was: "not compared",
      source: "stats",
    },
    {
      id: "errors",
      label: "Error rate",
      value: errorRate === null ? "—" : formatRateOrDash(errorRate),
      delta:
        compare && errorRate !== null && beforeErrorRate !== null
          ? formatPoints(errorRate - beforeErrorRate)
          : "—",
      tone:
        compare && errorRate !== null && beforeErrorRate !== null
          ? toneOf(errorRate - beforeErrorRate, "up", 0.001)
          : "neutral",
      was: beforeErrorRate === null ? "—" : formatRateOrDash(beforeErrorRate),
      source: "stats",
    },
    queriesKpi(data),
  ];
}

/** Release mode: everything is from the sampled traces of the two releases. */
export function releaseKpis(data: RouteExplainResponse): RouteKpi[] {
  const { before, after } = data;
  const has = before.traces > 0 && after.traces > 0;
  const dur = (b: number, a: number): Pick<RouteKpi, "delta" | "tone"> =>
    has
      ? {
          delta: formatChange(relativeChange(a, b)),
          tone: toneOf(relativeChange(a, b), "up", 0.02),
        }
      : { delta: "—", tone: "neutral" };
  return [
    {
      id: "traces",
      label: "Sampled traces",
      value: String(after.traces),
      delta: has
        ? formatChange(relativeChange(after.traces, before.traces))
        : "—",
      tone: "neutral",
      was: String(before.traces),
      source: "traces",
    },
    {
      id: "mean",
      label: "Mean time",
      value: after.traces > 0 ? formatDuration(after.meanMs) : "—",
      ...dur(before.meanMs, after.meanMs),
      was: before.traces > 0 ? formatDuration(before.meanMs) : "—",
      source: "traces",
    },
    {
      id: "p95",
      label: "p95",
      value: after.traces > 0 ? formatDuration(after.p95Ms) : "—",
      ...dur(before.p95Ms, after.p95Ms),
      was: before.traces > 0 ? formatDuration(before.p95Ms) : "—",
      source: "traces",
    },
    {
      id: "errors",
      label: "Error rate",
      value: after.traces > 0 ? formatRateOrDash(after.errorRate) : "—",
      delta: has ? formatPoints(after.errorRate - before.errorRate) : "—",
      tone: has
        ? toneOf(after.errorRate - before.errorRate, "up", 0.001)
        : "neutral",
      was: before.traces > 0 ? formatRateOrDash(before.errorRate) : "—",
      source: "traces",
    },
    queriesKpi(data),
  ];
}

export interface KindSegment {
  key: ExplainKindRow["key"];
  label: string;
  color: string;
  ms: number;
  /** Share of this bar, 0 to 1. */
  fraction: number;
}

/** One side's stacked bar: kinds with time, in the Overview's order and colours. */
export function kindSegments(
  kinds: readonly ExplainKindRow[],
  side: "before" | "after",
): { total: number; segments: KindSegment[] } {
  const ms = (k: ExplainKindRow) =>
    side === "before" ? k.beforeMs : k.afterMs;
  const total = kinds.reduce((sum, k) => sum + Math.max(0, ms(k)), 0);
  return {
    total,
    segments: kinds
      .filter((k) => ms(k) > 0)
      .map((k) => ({
        key: k.key,
        label: TIME_KINDS[k.key].label,
        color: TIME_KINDS[k.key].color,
        ms: ms(k),
        fraction: total > 0 ? ms(k) / total : 0,
      })),
  };
}

/** Width of a bar of `total` next to a longest one of `max`, in percent (at least 2 while it has time). */
export function barWidth(total: number, max: number): number {
  if (total <= 0 || max <= 0) return 0;
  return Math.min(100, Math.max(2, (total / max) * 100));
}

/** `shareOfChange` as a whole percentage text; null when it is not meaningful. */
export function formatShareOfChange(share: number | null): string | null {
  if (share === null || !Number.isFinite(share)) return null;
  return `${Math.round(Math.min(1, Math.max(0, share)) * 100)}% of the change`;
}

/** The name of each side in headings and legends. */
export function sideNames(data: {
  mode: RouteExplainResponse["mode"];
  before: ExplainSideInfo;
  after: ExplainSideInfo;
}): { before: string; after: string } {
  if (data.mode === "release")
    return { before: data.before.label, after: data.after.label };
  const minutes = Math.round(
    (data.after.toUnixMs - data.after.fromUnixMs) / 60_000,
  );
  return minutes > 0
    ? { before: `Previous ${minutes} min`, after: `Last ${minutes} min` }
    : { before: "Previous window", after: "Current window" };
}

export type CompareMode = "window" | "release";

/** What the picker has selected, as the URL says. Release mode needs two different releases. */
export function resolveCompare(
  compare: CompareMode | null,
  releaseA: string | null,
  releaseB: string | null,
  releases: readonly string[],
): { mode: CompareMode; releaseA: string | null; releaseB: string | null } {
  if (compare !== "release")
    return { mode: "window", releaseA: null, releaseB: null };
  // Releases come newest first; until one is picked, the two newest.
  return {
    mode: "release",
    releaseA: releaseA ?? releases[1] ?? null,
    releaseB: releaseB ?? releases[0] ?? null,
  };
}

/** The explain request for the page's state. */
export function explainParams(state: {
  method: string | null;
  route: string;
  windowMinutes: number;
  releaseA: string | null;
  releaseB: string | null;
  service: string | undefined;
}): QueryParams {
  const release = state.releaseA !== null && state.releaseB !== null;
  return {
    method: state.method ?? undefined,
    route: state.route,
    ...(release
      ? { releaseA: state.releaseA ?? "", releaseB: state.releaseB ?? "" }
      : { windowMinutes: state.windowMinutes }),
    service: state.service,
  };
}
