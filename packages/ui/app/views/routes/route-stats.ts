import type { RouteStats } from "@nestrix-js/protocol";

import type { ChartSeries } from "@/components/chart";
import { type SamplingMeta, STANDALONE_STATISTICS_NOTE } from "@/lib/format";

/** What the server calls requests that matched no route, and the overflow bucket past 500 keys. */
export const UNMATCHED_ROUTE = "(unmatched)";
export const OTHER_ROUTE = "(other)";

/** A route key shown for people: the raw key stays available as the title. */
export function describeRoute(stats: Pick<RouteStats, "method" | "route">): {
  label: string;
  note: string | null;
} {
  if (stats.route === UNMATCHED_ROUTE)
    return {
      label: UNMATCHED_ROUTE,
      note: "requests that matched no route",
    };
  if (stats.route === OTHER_ROUTE)
    return {
      label: OTHER_ROUTE,
      note: "all routes past the 500 the statistics keep apart",
    };
  return { label: stats.route, note: null };
}

/** `*` is the server's method for the overflow bucket. */
export const describeMethod = (method: string) =>
  method === "*" ? "any" : method;

export const routeKey = (stats: Pick<RouteStats, "method" | "route">) =>
  `${stats.method} ${stats.route}`;

/** Most requests first; ties by key so the order is stable between polls. */
export function sortByCount(routes: readonly RouteStats[]): RouteStats[] {
  return [...routes].sort(
    (a, b) => b.count - a.count || routeKey(a).localeCompare(routeKey(b)),
  );
}

/** "3.4%", "0%"; "-" for a route with no requests. */
export function formatErrorRate(errors: number, count: number): string {
  if (count <= 0) return "-";
  const percent = (errors / count) * 100;
  if (percent === 0) return "0%";
  return `${percent < 10 ? percent.toFixed(1) : percent.toFixed(0)}%`;
}

export interface RouteCharts {
  xs: number[];
  latency: ChartSeries[];
  traffic: ChartSeries[];
}

/** Series points as aligned arrays; a bucket without requests has no latency (a gap). */
export function chartData(stats: RouteStats): RouteCharts {
  const points = stats.series;
  return {
    xs: points.map((p) => p.timeUnixMs / 1000),
    latency: [
      {
        label: "p50",
        color: "--chart-1",
        values: points.map((p) => (p.count > 0 ? (p.p50Ms ?? null) : null)),
      },
      {
        label: "p95",
        color: "--chart-2",
        values: points.map((p) => (p.count > 0 ? (p.p95Ms ?? null) : null)),
      },
    ],
    traffic: [
      {
        label: "requests",
        color: "--chart-1",
        values: points.map((p) => p.count),
      },
      {
        label: "errors",
        color: "--chart-3",
        values: points.map((p) => p.errors),
      },
    ],
  };
}

/** The sentence under the routes heading; null when every request is stored. */
export function statisticsNote(
  sampling: SamplingMeta,
  mode?: "embedded" | "standalone",
): string | null {
  if (mode === "standalone") return STANDALONE_STATISTICS_NOTE;
  if (sampling.rate === null)
    return "Route statistics count every request. The host application owns the sampler, so the request and error lists may hold fewer.";
  if (sampling.rate < 1)
    return `Route statistics count every request. The request and error lists are sampled (${Math.round(
      sampling.rate * 100,
    )}% of requests are stored), so they hold fewer than these counts.`;
  return null;
}
