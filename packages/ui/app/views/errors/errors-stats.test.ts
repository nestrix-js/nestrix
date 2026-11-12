import type { ErrorGroup, ErrorReleaseStat } from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  bucketTotals,
  groupState,
  NO_ROUTE,
  NO_TYPE,
  OTHER_TYPES,
  peakCell,
  percentOf,
  releaseBars,
  releaseText,
  routeBreakdown,
  totalEvents,
  typeBreakdown,
  typeCounts,
} from "./errors-stats";

const NOW = 1_000_000_000;
const window15 = { toUnixMs: NOW, bucketMs: 60_000 };
const g = (
  count: number,
  extra: Partial<ErrorGroup> & { at?: Record<number, number> } = {},
): ErrorGroup => {
  const { at, ...rest } = extra;
  return {
    key: `k${count}${rest.errorType ?? ""}${rest.route ?? ""}`,
    pattern: "",
    count,
    firstSeenUnixMs: NOW - 1000,
    lastSeenUnixMs: NOW - 1000,
    series: Array.from({ length: 15 }, (_, i) => at?.[i] ?? 0),
    services: [],
    exampleTraceId: "t",
    recent: [],
    ...rest,
  };
};

describe("groupState", () => {
  it("is new when nothing happened in the first half of the window", () => {
    expect(groupState(g(3, { at: { 12: 1, 14: 2 } }), window15)).toBe("new");
  });
  it("is ongoing when it also occurred in the first half", () => {
    expect(groupState(g(3, { at: { 1: 1, 14: 2 } }), window15)).toBe("ongoing");
  });
  it("is quiet when the last occurrence is older than two buckets, even if it began early", () => {
    expect(
      groupState(
        g(2, { at: { 1: 2 }, lastSeenUnixMs: NOW - 5 * 60_000 }),
        window15,
      ),
    ).toBe("quiet");
    // Exactly two buckets ago still counts as active.
    expect(
      groupState(
        g(2, { at: { 13: 2 }, lastSeenUnixMs: NOW - 2 * 60_000 }),
        window15,
      ),
    ).toBe("new");
  });
});

describe("totals", () => {
  it("sums events and buckets across groups", () => {
    const groups = [g(3, { at: { 0: 1, 14: 2 } }), g(4, { at: { 14: 4 } })];
    expect(totalEvents(groups)).toBe(7);
    const buckets = bucketTotals(groups);
    expect(buckets).toHaveLength(15);
    expect(buckets[0]).toBe(1);
    expect(buckets[14]).toBe(6);
    expect(bucketTotals([])).toEqual([]);
  });
});

describe("typeBreakdown", () => {
  it("adds up groups of one type, orders by events and merges the tail into Other", () => {
    const groups = [
      g(5, { errorType: "A", at: { 14: 5 } }),
      g(2, { errorType: "A", route: "/x", at: { 13: 2 } }),
      g(4, { errorType: "B", at: { 14: 4 } }),
      g(3, { at: { 14: 3 } }),
      g(1, { errorType: "C", at: { 14: 1 } }),
    ];
    const two = typeBreakdown(groups, 2);
    expect(two.map((s) => [s.label, s.count])).toEqual([
      ["A", 7],
      ["B", 4],
      [OTHER_TYPES, 4],
    ]);
    expect(two[0]?.type).toBe("A");
    expect(two[2]?.type).toBeUndefined();
    expect(two[0]?.series[13]).toBe(2);
    expect(two[2]?.series[14]).toBe(4);
    const all = typeBreakdown(groups);
    expect(all.map((s) => s.label)).toEqual(["A", "B", NO_TYPE, "C"]);
    expect(new Set(all.map((s) => s.color)).size).toBe(4);
    expect(typeBreakdown([])).toEqual([]);
  });
});

describe("routeBreakdown", () => {
  it("counts events per route with a label for none, most first", () => {
    const groups = [
      g(2, { route: "/a" }),
      g(6, { route: "/b" }),
      g(1, { route: "/a" }),
      g(1),
    ];
    expect(routeBreakdown(groups).map((r) => [r.label, r.count])).toEqual([
      ["/b", 6],
      ["/a", 3],
      [NO_ROUTE, 1],
    ]);
    expect(routeBreakdown(groups, 1)).toHaveLength(1);
  });
});

describe("percentOf", () => {
  it("formats shares and says dash without a total", () => {
    expect(percentOf(1, 4)).toBe("25%");
    expect(percentOf(1, 30)).toBe("3.3%");
    expect(percentOf(1, 0)).toBe("—");
  });
});

describe("typeCounts", () => {
  it("counts events per type, most first, with a label for none", () => {
    const items = [
      { errorType: "B" },
      { errorType: "A" },
      { errorType: "A" },
      {},
    ];
    expect(typeCounts(items).map((t) => [t.label, t.count])).toEqual([
      ["A", 2],
      ["B", 1],
      [NO_TYPE, 1],
    ]);
    expect(typeCounts(items)[2]?.type).toBeUndefined();
    expect(typeCounts([])).toEqual([]);
  });
});

describe("groupState with a backend state (P15-02)", () => {
  it("uses the state the backend sent, whatever the series says", () => {
    expect(
      groupState(g(3, { at: { 1: 1, 14: 2 }, state: "regressed" }), window15),
    ).toBe("regressed");
    expect(
      groupState(g(3, { at: { 14: 2 }, state: "ongoing" }), window15),
    ).toBe("ongoing");
    expect(
      groupState(
        g(2, { at: { 14: 2 }, state: "quiet", lastSeenUnixMs: NOW }),
        window15,
      ),
    ).toBe("quiet");
  });
});

describe("releaseText", () => {
  it("shows the newest release, and the first one too when they differ", () => {
    expect(releaseText({})).toBeUndefined();
    expect(releaseText({ lastSeenRelease: "1.2.0" })).toBe("1.2.0");
    expect(
      releaseText({ firstSeenRelease: "1.2.0", lastSeenRelease: "1.2.0" }),
    ).toBe("1.2.0");
    expect(
      releaseText({ firstSeenRelease: "1.0.0", lastSeenRelease: "1.2.0" }),
    ).toBe("1.0.0 → 1.2.0");
  });
});

describe("peakCell", () => {
  it("finds the busiest weekday and hour, and nothing in an empty grid", () => {
    const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    expect(peakCell(grid)).toBeUndefined();
    (grid[2] as number[])[9] = 4;
    (grid[5] as number[])[23] = 2;
    expect(peakCell(grid)).toEqual({ weekday: "Wed", hour: "09", count: 4 });
  });
});

describe("releaseBars", () => {
  const stat = (
    release: string,
    events: number,
    requests?: number,
  ): ErrorReleaseStat => ({
    release,
    events,
    firstSeenUnixMs: 0,
    ...(requests === undefined
      ? {}
      : { requests, per1000Requests: (events / requests) * 1000 }),
  });

  it("charts errors per 1,000 requests when every release has requests", () => {
    const r = releaseBars([stat("1.0.0", 3, 1500), stat("1.1.0", 30, 1000)]);
    expect(r.metric).toBe("per1000");
    expect(r.bars.map((b) => b.value)).toEqual([2, 30]);
    expect(r.bars.map((b) => b.valueLabel)).toEqual(["2.0/1k", "30/1k"]);
    expect(r.bars[0]?.title).toBe("1.0.0: 3 events in 1,500 requests");
  });

  it("falls back to events, labelled, when a release has no requests", () => {
    const r = releaseBars([stat("1.0.0", 3, 1500), stat("1.1.0", 5)]);
    expect(r.metric).toBe("events");
    expect(r.bars.map((b) => b.value)).toEqual([3, 5]);
    expect(r.bars[1]?.valueLabel).toBe("5 events");
    expect(releaseBars([])).toEqual({ metric: "events", bars: [] });
  });
});
