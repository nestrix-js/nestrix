import { describe, expect, it } from "vitest";

import {
  CATEGORY_COLORS,
  categoryColor,
  PERCENTILE_COLOR,
  percentileColor,
} from "@/components/kit/series-colors";

describe("percentileColor", () => {
  it("is the same colour for a percentile on every page", () => {
    expect(percentileColor("p50")).toBe("--chart-1");
    expect(percentileColor("p95")).toBe("--chart-4");
    expect(percentileColor("p99")).toBe("--chart-5");
  });

  it("ignores case and knows no other series", () => {
    expect(percentileColor("P95")).toBe("--chart-4");
    expect(percentileColor("max")).toBeUndefined();
  });

  it("never uses a status colour", () => {
    for (const color of [
      ...Object.values(PERCENTILE_COLOR),
      ...CATEGORY_COLORS,
    ]) {
      expect(color).not.toMatch(/destructive|success|warning/);
    }
  });
});

describe("categoryColor", () => {
  it("wraps round the palette", () => {
    expect(categoryColor(0)).toBe(CATEGORY_COLORS[0]);
    expect(categoryColor(5)).toBe(CATEGORY_COLORS[0]);
    expect(categoryColor(7)).toBe(CATEGORY_COLORS[2]);
  });
});
