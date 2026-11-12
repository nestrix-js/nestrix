import type {
  RouteCompareResponse,
  RouteCompareRow,
  RouteStats,
} from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  compareByKey,
  formatChangePercent,
  formatPerMinute,
  noPreviousReason,
  rowChange,
  summarizeRoutes,
  topByP95,
  windowChanges,
} from "@/views/routes/route-kpis";

const route = (
  r: string,
  count: number,
  errors: number,
  p95Ms: number,
  counts: number[] = [],
): RouteStats => ({
  method: "GET",
  route: r,
  count,
  errors,
  p50Ms: p95Ms / 2,
  p95Ms,
  p99Ms: p95Ms * 2,
  maxMs: p95Ms * 3,
  series: counts.map((c, i) => ({
    timeUnixMs: i * 60_000,
    count: c,
    errors: i === 0 ? errors : 0,
  })),
});

const ROUTES = [
  route("/a", 60, 3, 100, [30, 30]),
  route("/b", 30, 0, 400, [10, 20]),
  route("/idle", 0, 0, 0, [0, 0]),
];

describe("summarizeRoutes", () => {
  it("adds up requests and errors, picks the worst p95 and sums the series", () => {
    const s = summarizeRoutes(ROUTES, 15);
    expect(s.routes).toBe(3);
    expect(s.requests).toBe(90);
    expect(s.requestsPerMinute).toBe(6);
    expect(s.errors).toBe(3);
    expect(s.errorRate).toBeCloseTo(3 / 90);
    expect(s.worst?.route).toBe("/b");
    expect(s.requestSeries).toEqual([40, 50]);
    expect(s.errorSeries).toEqual([3, 0]);
  });
  it("has no rate and no worst route without requests", () => {
    const s = summarizeRoutes([route("/idle", 0, 0, 0)], 15);
    expect(s.errorRate).toBeNull();
    expect(s.worst).toBeNull();
    expect(summarizeRoutes([], 15).requestSeries).toEqual([]);
  });
});

describe("topByP95", () => {
  it("lists the slowest routes first, skips routes without requests and honours the limit", () => {
    expect(topByP95(ROUTES).map((r) => r.route)).toEqual(["/b", "/a"]);
    expect(topByP95(ROUTES, 1).map((r) => r.route)).toEqual(["/b"]);
  });
});

describe("formatters", () => {
  it("formats a rate per minute", () => {
    expect(formatPerMinute(0.4)).toBe("0.4");
    expect(formatPerMinute(12.6)).toBe("13");
  });
  it("formats a change in percent, and has none without a base", () => {
    expect(formatChangePercent(100, 112)).toBe("+12%");
    expect(formatChangePercent(100, 96.5)).toBe("-3.5%");
    expect(formatChangePercent(50, 50)).toBe("0%");
    expect(formatChangePercent(0, 10)).toBeNull();
  });
});

const side = (count: number, errors: number, p95Ms: number) => ({
  count,
  errors,
  p50Ms: p95Ms / 2,
  p95Ms,
});
const compareRow = (
  r: string,
  before: ReturnType<typeof side>,
  after: ReturnType<typeof side>,
): RouteCompareRow => ({
  method: "GET",
  route: r,
  before,
  after,
  delta: {
    count: after.count - before.count,
    errorRate:
      (after.count ? after.errors / after.count : 0) -
      (before.count ? before.errors / before.count : 0),
    p50Ms:
      before.count && after.count ? (after.p95Ms - before.p95Ms) / 2 : null,
    p95Ms: before.count && after.count ? after.p95Ms - before.p95Ms : null,
  },
});
const windowCompare = (
  routes: RouteCompareRow[],
  previousCovered = true,
): RouteCompareResponse => ({
  mode: "window",
  windowMinutes: 15,
  previous: { fromUnixMs: 0, toUnixMs: 1 },
  current: { fromUnixMs: 1, toUnixMs: 2 },
  previousCovered,
  note: previousCovered ? null : "No previous hour is available.",
  releases: [],
  routes,
});

describe("windowChanges", () => {
  it("compares requests, error rate and the worst p95 with the previous window", () => {
    const c = windowChanges(
      windowCompare([
        compareRow("/a", side(100, 1, 100), side(120, 6, 150)),
        compareRow("/b", side(100, 1, 300), side(80, 0, 200)),
      ]),
    );
    expect(c.requests).toEqual({ text: "0%", tone: "neutral" });
    // 2/200 = 1% before, 6/200 = 3% after: two points worse.
    expect(c.errorRate).toEqual({ text: "+2.0 pt", tone: "worse" });
    // The worst p95 went from 300 ms to 200 ms: better.
    expect(c.worstP95).toEqual({ text: "-100 ms", tone: "better" });
  });
  it("says why there is no change instead of inventing one", () => {
    const uncovered = windowChanges(windowCompare([], false));
    expect(uncovered.requests.text).toBe("—");
    expect(uncovered.requests.title).toBe("No previous hour is available.");
    expect(windowChanges(undefined).errorRate.text).toBe("—");
    expect(
      windowChanges(
        windowCompare([compareRow("/a", side(0, 0, 0), side(5, 0, 9))]),
      ).requests.text,
    ).toBe("—");
  });
  it("has no previous window in release mode", () => {
    expect(
      noPreviousReason({
        mode: "release",
        releaseA: "a",
        releaseB: "b",
        releases: [],
        routes: [],
      }),
    ).toBe("No previous window to compare with.");
  });
});

describe("rowChange", () => {
  it("colours a regression, an improvement and no change, and keeps the sign in the text", () => {
    expect(
      rowChange(compareRow("/a", side(10, 0, 100), side(10, 0, 200))),
    ).toMatchObject({ text: "+100 ms", tone: "worse" });
    expect(
      rowChange(compareRow("/a", side(10, 0, 200), side(10, 0, 100))),
    ).toMatchObject({ text: "-100 ms", tone: "better" });
    expect(
      rowChange(compareRow("/a", side(10, 0, 100), side(10, 0, 101))),
    ).toMatchObject({ text: "+1.0 ms", tone: "neutral" });
  });
  it("is a dash without a row or without a delta", () => {
    expect(rowChange(undefined).text).toBe("—");
    expect(rowChange(compareRow("/a", side(0, 0, 0), side(3, 0, 9))).text).toBe(
      "—",
    );
  });
});

describe("compareByKey", () => {
  it("keys rows like the routes table and ignores release comparisons", () => {
    const row = compareRow("/a", side(1, 0, 1), side(1, 0, 1));
    expect(compareByKey(windowCompare([row])).get("GET /a")).toBe(row);
    expect(compareByKey(undefined).size).toBe(0);
  });
});
