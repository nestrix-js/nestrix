import type {
  Insight,
  OverviewResponse,
  OverviewTotals,
  RouteCompareRow,
} from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  apdexShares,
  buildKpis,
  donutSlices,
  formatApdexDelta,
  formatChange,
  formatPoints,
  formatRate,
  formatShare,
  formatShareChange,
  insightChange,
  insightHref,
  rankRoutes,
  relativeChange,
  ringDasharray,
  toneOf,
} from "./overview-format";

const totals = (over: Partial<OverviewTotals> = {}): OverviewTotals => ({
  count: 1000,
  errors: 10,
  errorRate: 0.01,
  p50Ms: 50,
  p95Ms: 400,
  p99Ms: 900,
  perMinute: 100,
  apdex: 0.9,
  satisfied: 800,
  tolerating: 150,
  frustrated: 50,
  ...over,
});

describe("formatChange", () => {
  it("signs the change and rounds it", () => {
    expect(formatChange(0.41)).toBe("+41%");
    expect(formatChange(-0.28)).toBe("−28%");
    expect(formatChange(0.062)).toBe("+6.2%");
    expect(formatChange(0.5)).toBe("+50%");
  });
  it("is a plain 0% when nothing visible changed, a dash when unknown", () => {
    expect(formatChange(0)).toBe("0%");
    expect(formatChange(0.0001)).toBe("0%");
    expect(formatChange(null)).toBe("—");
    expect(formatChange(Number.NaN)).toBe("—");
  });
});

describe("relativeChange", () => {
  it("is null without a usable before", () => {
    expect(relativeChange(5, null)).toBeNull();
    expect(relativeChange(5, 0)).toBeNull();
    expect(relativeChange(150, 100)).toBe(0.5);
  });
});

describe("formatPoints and formatApdexDelta", () => {
  it("formats differences of fractions as points", () => {
    expect(formatPoints(0.007)).toBe("+0.7 pt");
    expect(formatPoints(-0.0123)).toBe("−1.2 pt");
    expect(formatPoints(0)).toBe("0 pt");
    expect(formatPoints(null)).toBe("—");
    expect(formatApdexDelta(-0.03)).toBe("−0.03");
    expect(formatApdexDelta(0.04)).toBe("+0.04");
    expect(formatApdexDelta(null)).toBe("—");
  });
});

describe("formatShare and formatShareChange", () => {
  it("shows one decimal and never rounds up to 100% early", () => {
    expect(formatShare(0.964)).toBe("96.4%");
    expect(formatShare(0.009)).toBe("0.9%");
    expect(formatShare(0.9999)).toBe("100%");
    expect(formatShare(0.9951)).toBe("99.5%");
    expect(formatShareChange(0.41, 0.29)).toBe("+12.0 pt");
    expect(formatShareChange(0.41, null)).toBe("—");
  });
});

describe("formatRate", () => {
  it("keeps the precision a small number needs", () => {
    expect(formatRate(1284.4)).toBe("1,284");
    expect(formatRate(12.34)).toBe("12.3");
    expect(formatRate(3.2)).toBe("3.2");
    expect(formatRate(0.25)).toBe("0.25");
    expect(formatRate(0)).toBe("0");
  });
});

describe("toneOf", () => {
  it("says which direction is bad", () => {
    expect(toneOf(0.2, "up")).toBe("worse");
    expect(toneOf(-0.2, "up")).toBe("better");
    expect(toneOf(-0.03, "down")).toBe("worse");
    expect(toneOf(0.03, "down")).toBe("better");
  });
  it("is neutral for no data, a tiny change, or a direction that is no news", () => {
    expect(toneOf(null, "up")).toBe("neutral");
    expect(toneOf(0.0001, "up")).toBe("neutral");
    expect(toneOf(0.5, "none")).toBe("neutral");
  });
});

describe("buildKpis", () => {
  const response = (over: Partial<OverviewResponse>): OverviewResponse =>
    ({
      bucketMs: 60_000,
      totals: totals({
        perMinute: 120,
        errorRate: 0.019,
        p95Ms: 480,
        apdex: 0.86,
      }),
      previousTotals: totals(),
      series: [
        { timeUnixMs: 0, count: 100, errors: 5, p95Ms: 400 },
        { timeUnixMs: 60_000, count: 0, errors: 0 },
      ],
      ...over,
    }) as OverviewResponse;

  it("compares with the previous window and judges each direction", () => {
    const [throughput, errors, p95, apdex] = buildKpis(response({}));
    expect(throughput).toMatchObject({
      value: "120",
      delta: "+20%",
      tone: "neutral",
    });
    expect(errors).toMatchObject({
      value: "1.9",
      delta: "+0.9 pt",
      tone: "worse",
    });
    expect(p95).toMatchObject({
      value: "480",
      unit: "ms",
      delta: "+20%",
      tone: "worse",
    });
    expect(apdex).toMatchObject({
      value: "0.86",
      delta: "−0.04",
      tone: "worse",
    });
  });
  it("makes series with gaps into zeros and rates per bucket", () => {
    const kpis = buildKpis(response({}));
    expect(kpis[0]?.series).toEqual([100, 0]);
    expect(kpis[1]?.series).toEqual([0.05, 0]);
    expect(kpis[2]?.series).toEqual([400, 0]);
  });
  it("shows dashes and neutral tones without a previous window", () => {
    for (const kpi of buildKpis(response({ previousTotals: null }))) {
      expect(kpi.delta).toBe("—");
      expect(kpi.tone).toBe("neutral");
    }
  });
  it("switches the p95 unit with its size and shows no Apdex without requests", () => {
    const [, , p95, apdex] = buildKpis(
      response({
        totals: totals({ p95Ms: 1100, apdex: null }),
        previousTotals: null,
      }),
    );
    expect(p95).toMatchObject({ value: "1.10", unit: "s" });
    expect(apdex?.value).toBe("—");
  });
});

describe("apdexShares", () => {
  it("splits the three classes of the totals", () => {
    expect(apdexShares(totals())).toEqual({
      satisfied: 0.8,
      tolerating: 0.15,
      frustrated: 0.05,
    });
  });
  it("is all zero without requests", () => {
    expect(
      apdexShares(totals({ satisfied: 0, tolerating: 0, frustrated: 0 })),
    ).toEqual({ satisfied: 0, tolerating: 0, frustrated: 0 });
  });
});

describe("donutSlices", () => {
  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  it("lays slices end to end from the top and leaves out empty ones", () => {
    const slices = donutSlices(
      [
        { key: "a", value: 75, color: "--chart-1" },
        { key: "none", value: 0, color: "--chart-2" },
        { key: "b", value: 25, color: "--chart-3" },
      ],
      radius,
    );
    expect(slices.map((s) => s.key)).toEqual(["a", "b"]);
    expect(slices.map((s) => s.fraction)).toEqual([0.75, 0.25]);
    expect(slices[0]?.dashoffset).toBe(-0);
    expect(slices[1]?.dashoffset).toBeCloseTo(-0.75 * circumference, 6);
    const [arc] = (slices[0]?.dasharray ?? "").split(" ").map(Number);
    expect(arc).toBeCloseTo(0.75 * circumference, 1);
  });
  it("keeps a tiny slice visible", () => {
    const [big, tiny] = donutSlices(
      [
        { key: "big", value: 100_000, color: "--chart-1" },
        { key: "tiny", value: 1, color: "--chart-2" },
      ],
      radius,
    );
    expect(
      Number((tiny?.dasharray ?? "").split(" ")[0]),
    ).toBeGreaterThanOrEqual(1.5);
    expect(big?.fraction).toBeGreaterThan(0.999);
  });
  it("has no slices without values", () => {
    expect(
      donutSlices([{ key: "a", value: 0, color: "--chart-1" }], radius),
    ).toEqual([]);
  });
});

describe("ringDasharray", () => {
  it("fills a fraction of the circle and clamps", () => {
    const c = 2 * Math.PI * 10;
    expect(Number(ringDasharray(0.5, 10).split(" ")[0])).toBeCloseTo(c / 2, 1);
    expect(Number(ringDasharray(2, 10).split(" ")[0])).toBeCloseTo(c, 1);
    expect(Number(ringDasharray(-1, 10).split(" ")[0])).toBe(0);
  });
});

describe("insightHref and insightChange", () => {
  const insight = (over: Partial<Insight>): Insight => ({
    id: "x",
    kind: "route-latency",
    direction: "worse",
    severity: "high",
    title: "t",
    detail: "d",
    before: 100,
    after: 150,
    unit: "ms",
    change: 0.5,
    impact: 1,
    series: [],
    source: "stats",
    link: { view: "route", params: {} },
    ...over,
  });
  it("maps the target view to its path with its params", () => {
    expect(
      insightHref({
        view: "route",
        params: { method: "POST", route: "/orders" },
      }),
    ).toBe("/routes?method=POST&route=%2Forders");
    expect(insightHref({ view: "errors", params: {} })).toBe("/errors");
    expect(insightHref({ view: "dependencies", params: {} })).toBe(
      "/dependencies",
    );
    expect(insightHref({ view: "slos", params: {} })).toBe("/slos");
  });
  it("says new for something without a before", () => {
    expect(insightChange(insight({}))).toBe("+50%");
    expect(insightChange(insight({ before: null, change: null }))).toBe("new");
    expect(insightChange(insight({ change: null }))).toBe("—");
  });
});

describe("rankRoutes", () => {
  const row = (
    route: string,
    beforeCount: number,
    beforeP95: number,
    afterCount: number,
    afterP95: number,
  ): RouteCompareRow => ({
    method: "GET",
    route,
    before: { count: beforeCount, errors: 0, p50Ms: 1, p95Ms: beforeP95 },
    after: { count: afterCount, errors: 0, p50Ms: 1, p95Ms: afterP95 },
    delta: { count: 0, errorRate: 0, p50Ms: null, p95Ms: null },
  });
  it("ranks by requests times the size of the p95 change, either direction", () => {
    const ranked = rankRoutes([
      row("/small", 100, 100, 100, 110),
      row("/big-change", 100, 100, 100, 300),
      row("/busy-faster", 1000, 200, 1000, 100),
    ]);
    expect(ranked.map((r) => r.row.route)).toEqual([
      "/busy-faster",
      "/big-change",
      "/small",
    ]);
    expect(ranked[0]?.impact).toBeCloseTo(500, 6);
    expect(ranked[0]?.change).toBe(-0.5);
  });
  it("caps the change at 10 times and puts routes without a comparison last, busiest first", () => {
    const ranked = rankRoutes([
      row("/new-busy", 0, 0, 5000, 90),
      row("/new-small", 0, 0, 10, 90),
      row("/exploded", 10, 1, 10, 1000),
    ]);
    expect(ranked.map((r) => r.row.route)).toEqual([
      "/exploded",
      "/new-busy",
      "/new-small",
    ]);
    expect(ranked[0]?.impact).toBe(100);
    expect(ranked[1]?.change).toBeNull();
  });
});
