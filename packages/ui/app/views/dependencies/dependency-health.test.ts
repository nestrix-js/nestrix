import { describe, expect, it } from "vitest";

import {
  callsSeries,
  dependencyHealth,
  formatErrorRate,
} from "@/views/dependencies/dependency-health";

const point = (calls: number) => ({ startUnixMs: 0, calls, p95Ms: 0 });
const dep = (id: string, calls: number[]) => ({
  id,
  name: id,
  series: calls.map(point),
});

describe("dependencyHealth", () => {
  it("is healthy below 1% errors and a 1 s p95", () => {
    expect(dependencyHealth({ errorRate: 0, p95Ms: 12 })).toBe("healthy");
    expect(dependencyHealth({ errorRate: 0.0099, p95Ms: 999 })).toBe("healthy");
  });

  it("is degraded from 1% errors or a 1 s p95", () => {
    expect(dependencyHealth({ errorRate: 0.01, p95Ms: 5 })).toBe("degraded");
    expect(dependencyHealth({ errorRate: 0, p95Ms: 1000 })).toBe("degraded");
    expect(dependencyHealth({ errorRate: 0.049, p95Ms: 5 })).toBe("degraded");
  });

  it("is failing from 5% errors, whatever the latency", () => {
    expect(dependencyHealth({ errorRate: 0.05, p95Ms: 5 })).toBe("failing");
    expect(dependencyHealth({ errorRate: 0.5, p95Ms: 9000 })).toBe("failing");
  });
});

describe("formatErrorRate", () => {
  it("prints a dash-free percentage", () => {
    expect(formatErrorRate({ errors: 0, errorRate: 0 })).toBe("0%");
    expect(formatErrorRate({ errors: 12, errorRate: 0.05 })).toBe("5.0%");
    expect(formatErrorRate({ errors: 30, errorRate: 0.125 })).toBe("13%");
  });
});

describe("callsSeries", () => {
  it("keeps the top dependencies and sums the rest as Other", () => {
    const series = callsSeries(
      [
        dep("a", [1, 2, 3]),
        dep("b", [4, 5, 6]),
        dep("c", [1, 1, 1]),
        dep("d", [0, 2, 0]),
      ],
      2,
    );
    expect(series.map((s) => s.id)).toEqual(["a", "b", "other"]);
    expect(series[2]).toMatchObject({ label: "Other (2)", values: [1, 3, 1] });
  });

  it("adds no Other when everything is shown, and pads short series with zeros", () => {
    const series = callsSeries([dep("a", [1, 2, 3]), dep("b", [4])], 5);
    expect(series.map((s) => s.id)).toEqual(["a", "b"]);
    expect(series[1]?.values).toEqual([4, 0, 0]);
  });

  it("answers nothing when no call was made", () => {
    expect(callsSeries([dep("a", [0, 0])], 3)).toEqual([]);
    expect(callsSeries([], 3)).toEqual([]);
  });
});
