import type {
  CompareSide,
  HistogramBucket,
  RouteCompareRow,
} from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  bucketFilter,
  bucketIndexOf,
  bucketLabel,
  formatDeltaMs,
  formatDeltaRate,
  requestsLink,
  sortCompareRows,
  verdictOf,
} from "@/views/routes/route-insights";

const buckets: HistogramBucket[] = [
  { fromMs: 0, toMs: 1, count: 0 },
  { fromMs: 1, toMs: 1.5, count: 4 },
  { fromMs: 1.5, toMs: 60_000, count: 2 },
  { fromMs: 60_000, toMs: null, count: 1 },
];

const side = (count: number, errors: number, p95Ms: number): CompareSide => ({
  count,
  errors,
  p50Ms: p95Ms / 2,
  p95Ms,
});
function row(
  route: string,
  before: CompareSide,
  after: CompareSide,
): RouteCompareRow {
  const both = before.count > 0 && after.count > 0;
  const rate = (s: CompareSide) => (s.count ? s.errors / s.count : 0);
  return {
    method: "GET",
    route,
    before,
    after,
    delta: {
      count: after.count - before.count,
      errorRate: rate(after) - rate(before),
      p50Ms: both ? after.p50Ms - before.p50Ms : null,
      p95Ms: both ? after.p95Ms - before.p95Ms : null,
    },
  };
}

describe("histogram buckets", () => {
  it("links a bucket to the request list with its latency range, leaving open ends open", () => {
    const h = { route: "/orders/:id", method: "GET" };
    expect(bucketFilter(h, buckets[1] as HistogramBucket)).toEqual({
      route: "/orders/:id",
      method: "GET",
      minDurationMs: 1,
      maxDurationMs: 1.5,
    });
    expect(bucketFilter(h, buckets[0] as HistogramBucket)).toEqual({
      route: "/orders/:id",
      method: "GET",
      maxDurationMs: 1,
    });
    expect(
      bucketFilter(
        { route: "/a", method: null },
        buckets[3] as HistogramBucket,
      ),
    ).toEqual({
      route: "/a",
      minDurationMs: 60_000,
    });
    expect(requestsLink({ route: "/a/:id", minDurationMs: 2 })).toBe(
      "/requests?route=%2Fa%2F%3Aid&minDurationMs=2",
    );
  });

  it("finds the bucket of a value and labels buckets", () => {
    expect(bucketIndexOf(buckets, 0.2)).toBe(0);
    expect(bucketIndexOf(buckets, 1)).toBe(0); // (from, to]
    expect(bucketIndexOf(buckets, 1.2)).toBe(1);
    expect(bucketIndexOf(buckets, 90_000)).toBe(3);
    expect(bucketLabel(buckets[0] as HistogramBucket)).toBe("up to 1.0 ms");
    expect(bucketLabel(buckets[2] as HistogramBucket)).toBe(
      "1.5 ms to 1.0 min",
    );
    expect(bucketLabel(buckets[3] as HistogramBucket)).toBe("over 1.0 min");
  });
});

describe("compare verdicts and sorting", () => {
  it("flags a slower p95 or a higher error rate as a regression, only past the thresholds", () => {
    expect(verdictOf(row("/a", side(10, 0, 100), side(10, 0, 130)))).toBe(
      "regression",
    );
    // 4 ms slower is under 5 ms; 10% slower is under 20%.
    expect(verdictOf(row("/a", side(10, 0, 10), side(10, 0, 14)))).toBe("same");
    expect(verdictOf(row("/a", side(10, 0, 100), side(10, 0, 110)))).toBe(
      "same",
    );
    expect(verdictOf(row("/a", side(100, 0, 10), side(100, 3, 10)))).toBe(
      "regression",
    );
    expect(verdictOf(row("/a", side(10, 0, 100), side(10, 0, 50)))).toBe(
      "improvement",
    );
    // A route that vanished or appeared has no percentile delta and is not a regression.
    expect(verdictOf(row("/gone", side(5, 0, 10), side(0, 0, 0)))).toBe("same");
    expect(verdictOf(row("/new", side(0, 0, 0), side(5, 0, 900)))).toBe("same");
  });

  it("sorts by a delta column both ways and keeps unknown deltas last", () => {
    const rows = [
      row("/a", side(10, 0, 100), side(10, 0, 120)),
      row("/b", side(10, 0, 100), side(10, 0, 300)),
      row("/new", side(0, 0, 0), side(5, 0, 10)),
      row("/c", side(10, 0, 100), side(10, 0, 90)),
    ];
    const order = (dir: "asc" | "desc") =>
      sortCompareRows(rows, "p95Ms", dir).map((r) => r.route);
    expect(order("desc")).toEqual(["/b", "/a", "/c", "/new"]);
    expect(order("asc")).toEqual(["/c", "/a", "/b", "/new"]);
    expect(sortCompareRows(rows, "route", "asc").map((r) => r.route)).toEqual([
      "/a",
      "/b",
      "/c",
      "/new",
    ]);
  });

  it("formats deltas with a sign", () => {
    expect(formatDeltaMs(12)).toBe("+12.0 ms");
    expect(formatDeltaMs(-3.4)).toBe("-3.4 ms");
    expect(formatDeltaMs(null)).toBe("-");
    expect(formatDeltaRate(0.02)).toBe("+2.0 pt");
    expect(formatDeltaRate(-0.005)).toBe("-0.5 pt");
  });
});
