import type {
  ErrorGroup,
  ErrorGroupState,
  ErrorGroupsResponse,
  ErrorReleaseStat,
} from "@nestrix-js/protocol";

/** A group's state; the backend computes it (`ErrorGroup.state`), see `ErrorGroupState`. */
export type GroupState = ErrorGroupState;

export const STATE_LABEL: Record<GroupState, string> = {
  new: "New",
  regressed: "Regressed",
  ongoing: "Ongoing",
  quiet: "Quiet",
};

/** Words for the tooltip of each state, so the chip says how it was derived. */
export const STATE_TITLE: Record<GroupState, string> = {
  new: "First seen inside this window: nothing stored before it",
  regressed:
    "Seen before, absent for at least 24 hours or a whole release, and back in this window",
  ongoing: "Seen before this window, or early in it, and still occurring",
  quiet: "No occurrence in the last two buckets of the window",
};

export const STATE_ORDER: readonly GroupState[] = [
  "new",
  "regressed",
  "ongoing",
  "quiet",
];

/**
 * A group's state: the one the backend computed from its stored history. An older backend sends
 * none, so the state then comes from the series alone (Quiet: nothing in the last two buckets;
 * New: nothing in the window's first half; else Ongoing; never Regressed).
 */
export function groupState(
  group: Pick<ErrorGroup, "series" | "lastSeenUnixMs" | "state">,
  response: Pick<ErrorGroupsResponse, "toUnixMs" | "bucketMs">,
): GroupState {
  if (group.state !== undefined) return group.state;
  if (group.lastSeenUnixMs < response.toUnixMs - 2 * response.bucketMs)
    return "quiet";
  const half = Math.floor(group.series.length / 2);
  if (group.series.slice(0, half).every((n) => n === 0)) return "new";
  return "ongoing";
}

/**
 * The release column of a group: the newest release it was seen in, "1.0.0 → 1.2.0" when it first
 * appeared in an older one; undefined when no occurrence carries a release.
 */
export function releaseText(
  group: Pick<ErrorGroup, "firstSeenRelease" | "lastSeenRelease">,
): string | undefined {
  const { firstSeenRelease: first, lastSeenRelease: last } = group;
  if (last === undefined) return first;
  return first !== undefined && first !== last ? `${first} → ${last}` : last;
}

/** Row labels of the weekday x hour grid (Monday first, as the API's rows) and its columns. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const HOURS = Array.from({ length: 24 }, (_, h) =>
  String(h).padStart(2, "0"),
);

/** The busiest weekday and hour of the grid, for the chart's label; undefined when it is empty. */
export function peakCell(
  heatmap: readonly (readonly number[])[],
): { weekday: string; hour: string; count: number } | undefined {
  let best: { weekday: number; hour: number; count: number } | undefined;
  heatmap.forEach((row, weekday) => {
    row.forEach((count, hour) => {
      if (count > 0 && (best === undefined || count > best.count))
        best = { weekday, hour, count };
    });
  });
  if (best === undefined) return undefined;
  return {
    weekday: WEEKDAYS[best.weekday] ?? "",
    hour: HOURS[best.hour] ?? "",
    count: best.count,
  };
}

export interface ReleaseBar {
  release: string;
  value: number;
  /** Text next to the bar. */
  valueLabel: string;
  title: string;
}

/**
 * The bars of "Errors per release": errors per 1,000 requests when every release has requests,
 * else plain events (`metric` says which, so the card can label it).
 */
export function releaseBars(releases: readonly ErrorReleaseStat[]): {
  metric: "per1000" | "events";
  bars: ReleaseBar[];
} {
  const metric =
    releases.length > 0 &&
    releases.every((r) => r.per1000Requests !== undefined)
      ? "per1000"
      : "events";
  return {
    metric,
    bars: releases.map((r) => {
      const rate = r.per1000Requests;
      const events = `${r.events.toLocaleString("en")} events`;
      const requests =
        r.requests === undefined
          ? ""
          : ` in ${r.requests.toLocaleString("en")} requests`;
      const rated = metric === "per1000" && rate !== undefined;
      return {
        release: r.release,
        value: rated ? rate : r.events,
        valueLabel: rated
          ? `${rate < 10 ? rate.toFixed(1) : Math.round(rate)}/1k`
          : events,
        title: `${r.release}: ${events}${requests}`,
      };
    }),
  };
}

export function totalEvents(groups: readonly ErrorGroup[]): number {
  return groups.reduce((sum, g) => sum + g.count, 0);
}

/** Occurrences per bucket across all groups (the longest series sets the length). */
export function bucketTotals(groups: readonly ErrorGroup[]): number[] {
  const length = Math.max(0, ...groups.map((g) => g.series.length));
  return Array.from({ length }, (_, i) =>
    groups.reduce((sum, g) => sum + (g.series[i] ?? 0), 0),
  );
}

export const NO_TYPE = "No type";
export const OTHER_TYPES = "Other";
/** Chart colours of the most frequent types, then the grey of "Other". */
export const TYPE_COLORS = [
  "--chart-3",
  "--warning",
  "--chart-4",
  "--chart-1",
  "--chart-5",
] as const;
export const OTHER_COLOR = "--muted-foreground";

export interface TypeSlice {
  /** The exception type as shown ("No type" when the errors carry none). */
  label: string;
  /** The real `errorType`, for a filter link; absent for "No type" and "Other". */
  type?: string;
  count: number;
  color: string;
  /** Per bucket, oldest first. */
  series: number[];
}

/**
 * The exception types by events, most first: the top `max` each with a colour, the rest merged
 * into "Other". Groups of one type (different messages or routes) add up.
 */
export function typeBreakdown(
  groups: readonly ErrorGroup[],
  max: number = TYPE_COLORS.length,
): TypeSlice[] {
  const length = Math.max(0, ...groups.map((g) => g.series.length));
  const byType = new Map<string, { type?: string; series: number[] }>();
  for (const g of groups) {
    const label = g.errorType ?? NO_TYPE;
    const entry = byType.get(label) ?? {
      ...(g.errorType === undefined ? {} : { type: g.errorType }),
      series: new Array<number>(length).fill(0),
    };
    g.series.forEach((n, i) => {
      entry.series[i] = (entry.series[i] ?? 0) + n;
    });
    byType.set(label, entry);
  }
  const sum = (series: readonly number[]) => series.reduce((a, b) => a + b, 0);
  // Counted from the groups' counts, not the series, so a type is never under-reported.
  const counts = new Map<string, number>();
  for (const g of groups) {
    const label = g.errorType ?? NO_TYPE;
    counts.set(label, (counts.get(label) ?? 0) + g.count);
  }
  const sorted = [...byType.entries()]
    .map(([label, e]) => ({
      label,
      ...e,
      count: counts.get(label) ?? sum(e.series),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const top = sorted.slice(0, max).map(
    (s, i): TypeSlice => ({
      label: s.label,
      ...(s.type === undefined ? {} : { type: s.type }),
      count: s.count,
      color: TYPE_COLORS[i] ?? OTHER_COLOR,
      series: s.series,
    }),
  );
  const rest = sorted.slice(max);
  if (rest.length === 0) return top;
  const series = new Array<number>(length).fill(0);
  for (const r of rest)
    r.series.forEach((n, i) => {
      series[i] = (series[i] ?? 0) + n;
    });
  return [
    ...top,
    {
      label: OTHER_TYPES,
      count: rest.reduce((a, r) => a + r.count, 0),
      color: OTHER_COLOR,
      series,
    },
  ];
}

export interface RouteSlice {
  /** The route as shown ("No route" for errors outside a request). */
  label: string;
  /** The real route, for a filter link; absent for "No route". */
  route?: string;
  count: number;
}

export const NO_ROUTE = "No route";

/** Events per route, most first, at most `max` routes. */
export function routeBreakdown(
  groups: readonly ErrorGroup[],
  max = 6,
): RouteSlice[] {
  const byRoute = new Map<string, RouteSlice>();
  for (const g of groups) {
    const label = g.route ?? NO_ROUTE;
    const entry = byRoute.get(label) ?? {
      label,
      ...(g.route === undefined ? {} : { route: g.route }),
      count: 0,
    };
    entry.count += g.count;
    byRoute.set(label, entry);
  }
  return [...byRoute.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, max);
}

/** Percentage of `total`, one decimal below 10: "42%", "3.4%"; "—" for no total. */
export function percentOf(part: number, total: number): string {
  if (!(total > 0)) return "—";
  const p = (part / total) * 100;
  return `${p < 10 ? p.toFixed(1).replace(/\.0$/, "") : Math.round(p)}%`;
}

export interface TypeCount {
  label: string;
  /** The real `errorType`; absent for "No type". */
  type?: string;
  count: number;
}

/** The exception types of a list of error events, most events first. */
export function typeCounts(
  items: readonly { errorType?: string | undefined }[],
): TypeCount[] {
  const counts = new Map<string, TypeCount>();
  for (const item of items) {
    const label = item.errorType ?? NO_TYPE;
    const entry = counts.get(label) ?? {
      label,
      ...(item.errorType === undefined ? {} : { type: item.errorType }),
      count: 0,
    };
    entry.count += 1;
    counts.set(label, entry);
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
}
