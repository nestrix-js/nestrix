import type { RouteStats, RouteStatsResponse } from "@nestrix/protocol";
import { describe, expect, it } from "vitest";

import {
  chartData,
  describeMethod,
  describeRoute,
  formatErrorRate,
  sortByCount,
  statisticsNote,
} from "@/views/routes/route-stats";

// The protocol fixtures sit outside this package's TypeScript root, so they are loaded by path.
const { routes } = (await import(
  new URL("../../../../protocol/fixtures/index.ts", import.meta.url).href
)) as { routes: RouteStatsResponse };

const stat = (over: Partial<RouteStats>): RouteStats => ({
  method: "GET",
  route: "/x",
  count: 1,
  errors: 0,
  p50Ms: 1,
  p95Ms: 1,
  p99Ms: 1,
  maxMs: 1,
  series: [],
  ...over,
});

describe("sortByCount", () => {
  it("orders by request count, ties by key, without changing the input", () => {
    const input = [
      stat({ route: "/b", count: 5 }),
      stat({ route: "/a", count: 5 }),
      stat({ route: "/c", count: 50 }),
    ];
    expect(sortByCount(input).map((r) => r.route)).toEqual(["/c", "/a", "/b"]);
    expect(input.map((r) => r.route)).toEqual(["/b", "/a", "/c"]);
  });
  it("sorts the protocol fixture busiest first", () => {
    expect(sortByCount(routes.routes)[0]?.route).toBe("/orders/:id");
  });
});

describe("route keys", () => {
  it("explains the server's special keys and leaves real routes alone", () => {
    expect(describeRoute({ method: "GET", route: "(unmatched)" }).note).toMatch(
      /no route/,
    );
    expect(describeRoute({ method: "*", route: "(other)" }).note).toMatch(
      /500/,
    );
    expect(describeRoute({ method: "GET", route: "/users/:id" })).toEqual({
      label: "/users/:id",
      note: null,
    });
    expect(describeMethod("*")).toBe("any");
    expect(describeMethod("POST")).toBe("POST");
  });
});

describe("formatErrorRate", () => {
  it("formats, and does not divide by zero", () => {
    expect(formatErrorRate(0, 0)).toBe("-");
    expect(formatErrorRate(0, 10)).toBe("0%");
    expect(formatErrorRate(6, 140)).toBe("4.3%");
    expect(formatErrorRate(1, 2)).toBe("50%");
  });
});

describe("chartData", () => {
  it("aligns series with the buckets and leaves gaps where nothing was served", () => {
    const post = routes.routes[1] as RouteStats;
    const data = chartData(post);
    expect(data.xs).toHaveLength(post.series.length);
    expect(data.xs[0]).toBe(
      (post.series[0] as { timeUnixMs: number }).timeUnixMs / 1000,
    );
    expect(data.latency[1]?.label).toBe("p95");
    expect(data.latency[1]?.values).toEqual([null, 88, 120.5, null, null]);
    expect(data.traffic[0]?.values).toEqual([0, 4, 8, 0, 0]);
    expect(data.traffic[1]?.values).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("statisticsNote in standalone mode", () => {
  it("says the statistics come from stored spans, whatever the sampling", () => {
    for (const sampling of [
      { owner: "host", rate: null },
      { owner: "nestrix", rate: 1 },
    ] as const)
      expect(statisticsNote(sampling, "standalone")).toMatch(/stored spans/);
  });
});

describe("statisticsNote", () => {
  it("is silent at full sampling and states the rate otherwise", () => {
    expect(statisticsNote({ owner: "nestrix", rate: 1 })).toBeNull();
    expect(statisticsNote({ owner: "nestrix", rate: 0.25 })).toMatch(
      /sampled \(25%/,
    );
    expect(statisticsNote({ owner: "host", rate: null })).toMatch(/may hold/);
  });
});
