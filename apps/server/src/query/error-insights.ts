/**
 * Error insights (P15-02): error events by weekday and hour (UTC) and per release. Pure
 * functions. `packages/nestjs/src/store/error-insights.ts` is the embedded copy (it
 * cannot import this package's internals); keep the two in step, both have the same unit tests.
 */
import type {
  ErrorInsightsResponse,
  ErrorReleaseStat,
} from "@nestrix-js/protocol";

export const INSIGHTS_DAYS = 7;
export const INSIGHTS_MS = INSIGHTS_DAYS * 24 * 3_600_000;
const MAX_RELEASES = 8;

/** 7 rows (Monday to Sunday) of 24 hourly counts, all zero. */
export function emptyHeatmap(): number[][] {
  return Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
}

/** Monday = 0 ... Sunday = 6, and the hour 0 to 23, both in UTC. */
export function cellOf(unixMs: number): { weekday: number; hour: number } {
  const d = new Date(unixMs);
  return { weekday: (d.getUTCDay() + 6) % 7, hour: d.getUTCHours() };
}

/** Counts one event into the heatmap; a time outside the calendar is ignored. */
export function addToHeatmap(heatmap: number[][], unixMs: number): void {
  if (!Number.isFinite(unixMs)) return;
  const { weekday, hour } = cellOf(unixMs);
  const row = heatmap[weekday];
  if (row !== undefined) row[hour] = (row[hour] ?? 0) + 1;
}

export interface ReleaseCount {
  release: string;
  events: number;
  requests?: number | undefined;
  firstSeenUnixMs: number;
}

/**
 * The response from the heatmap and per-release counts: the newest 8 releases (by first seen),
 * oldest first, each with errors per 1,000 requests when it has requests.
 */
export function assembleInsights(input: {
  now: number;
  heatmap: number[][];
  coveredFromUnixMs: number;
  releases: readonly ReleaseCount[];
}): ErrorInsightsResponse {
  const fromUnixMs = input.now - INSIGHTS_MS;
  const releases = input.releases
    .filter((r) => r.events > 0 || (r.requests ?? 0) > 0)
    .sort((a, b) => b.firstSeenUnixMs - a.firstSeenUnixMs)
    .slice(0, MAX_RELEASES)
    .reverse()
    .map((r): ErrorReleaseStat => {
      const stat: ErrorReleaseStat = {
        release: r.release,
        events: r.events,
        firstSeenUnixMs: r.firstSeenUnixMs,
      };
      if (r.requests !== undefined && r.requests > 0) {
        stat.requests = r.requests;
        stat.per1000Requests = (r.events / r.requests) * 1000;
      }
      return stat;
    });
  return {
    fromUnixMs,
    toUnixMs: input.now,
    coveredFromUnixMs: Math.min(
      input.now,
      Math.max(fromUnixMs, input.coveredFromUnixMs),
    ),
    zone: "UTC",
    heatmap: input.heatmap,
    total: input.heatmap.reduce(
      (sum, row) => sum + row.reduce((a, b) => a + b, 0),
      0,
    ),
    releases,
  };
}
