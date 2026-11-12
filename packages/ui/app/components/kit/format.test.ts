import { describe, expect, it } from "vitest";

import {
  areaPath,
  barPercent,
  CHART_H,
  CHART_W,
  compactNumber,
  cumulativeSeries,
  donutSlices,
  heatLevel,
  heatOpacity,
  linePath,
  niceMax,
  ringDasharray,
  stackHeights,
} from "@/components/kit/format";

describe("barPercent", () => {
  it("is the share of the maximum, clamped", () => {
    expect(barPercent(50, 200)).toBe(25);
    expect(barPercent(200, 200)).toBe(100);
    expect(barPercent(300, 200)).toBe(100);
    expect(barPercent(-5, 200)).toBe(0);
  });
  it("is 0 without a positive maximum or a finite value", () => {
    expect(barPercent(5, 0)).toBe(0);
    expect(barPercent(Number.NaN, 10)).toBe(0);
  });
});

describe("niceMax", () => {
  it("rounds up to 1, 2, 5 times a power of ten", () => {
    expect(niceMax(0.7)).toBe(1);
    expect(niceMax(1.2)).toBe(2);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(5.1)).toBe(10);
    expect(niceMax(240)).toBe(500);
    expect(niceMax(1000)).toBe(1000);
  });
  it("is 1 for nothing", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
  });
});

describe("compactNumber", () => {
  it("shortens thousands and millions", () => {
    expect(compactNumber(950)).toBe("950");
    expect(compactNumber(1200)).toBe("1.2k");
    expect(compactNumber(1000)).toBe("1k");
    expect(compactNumber(34_500)).toBe("35k");
    expect(compactNumber(2_500_000)).toBe("2.5M");
  });
  it("shows a dash for a non-number", () => {
    expect(compactNumber(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("stackHeights", () => {
  const seg = (value: number) => ({ value, color: "--chart-1" });
  it("scales segments against the chart maximum and drops empty ones", () => {
    const out = stackHeights([seg(50), seg(0), seg(25)], 100);
    expect(out.map((s) => s.percent)).toEqual([50, 25]);
  });
  it("scales a total above the maximum to fit", () => {
    const out = stackHeights([seg(100), seg(100)], 100);
    expect(out.map((s) => s.percent)).toEqual([50, 50]);
  });
  it("has no segments for no data", () => {
    expect(stackHeights([seg(0)], 0)).toEqual([]);
  });
});

describe("heatLevel and heatOpacity", () => {
  it("is 0 for nothing and at least 1 for any value", () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(0.01, 10)).toBe(1);
    expect(heatLevel(10, 10)).toBe(5);
    expect(heatLevel(5, 10)).toBe(3);
    expect(heatLevel(50, 10)).toBe(5);
  });
  it("is 0 without a maximum", () => {
    expect(heatLevel(5, 0)).toBe(0);
  });
  it("rises with the level and is invisible only at level 0", () => {
    expect(heatOpacity(0)).toBe(0);
    expect(heatOpacity(1)).toBeGreaterThan(0.18);
    expect(heatOpacity(5)).toBeCloseTo(1);
    expect(heatOpacity(2)).toBeGreaterThan(heatOpacity(1));
  });
});

describe("linePath, areaPath and cumulativeSeries", () => {
  it("draws a gap as a new subpath", () => {
    const d = linePath([1, 2, null, 3], 3);
    expect(d.match(/M/g)).toHaveLength(2);
    expect(linePath([], 1)).toBe("");
    expect(linePath([null, null], 1)).toBe("");
  });
  it("puts the maximum at the top and zero at the baseline", () => {
    expect(linePath([3], 3)).toBe(`M${CHART_W / 2}.0 8.0`);
    expect(linePath([0], 3)).toBe(`M${CHART_W / 2}.0 ${CHART_H - 4}.0`);
  });
  it("closes an area down to the baseline, one shape per run", () => {
    const d = areaPath([1, 2, null, 3, 3], 3);
    expect(d.match(/Z/g)).toHaveLength(2);
    expect(d).toContain(`L0.0 ${CHART_H}`);
    expect(areaPath([null], 1)).toBe("");
  });
  it("stacks series by running total", () => {
    expect(
      cumulativeSeries([
        [1, 2, null],
        [1, null, 4],
      ]),
    ).toEqual([
      [1, 2, 0],
      [2, 2, 4],
    ]);
    expect(cumulativeSeries([])).toEqual([]);
  });
});

describe("donutSlices and ringDasharray", () => {
  it("lays slices end to end from the top and skips empty ones", () => {
    const slices = donutSlices(
      [
        { key: "a", value: 3, color: "--chart-1" },
        { key: "b", value: 0, color: "--chart-2" },
        { key: "c", value: 1, color: "--chart-3" },
      ],
      10,
    );
    expect(slices.map((s) => s.key)).toEqual(["a", "c"]);
    expect(slices[0]?.fraction).toBe(0.75);
    expect(slices[1]?.dashoffset).toBeCloseTo(-0.75 * 2 * Math.PI * 10);
  });
  it("fills a ring in proportion and clamps", () => {
    const circumference = 2 * Math.PI * 10;
    expect(ringDasharray(0.5, 10)).toBe(
      `${(circumference / 2).toFixed(2)} ${(circumference / 2).toFixed(2)}`,
    );
    expect(ringDasharray(2, 10)).toBe(`${circumference.toFixed(2)} 0.00`);
  });
});
