import { describe, expect, it } from "vitest";

import {
  budgetColor,
  burnBarPercent,
  summarizeSlos,
} from "@/views/slos/slo-format";

describe("burnBarPercent", () => {
  it("scales a rate against the end of the scale and clamps it", () => {
    expect(burnBarPercent(5, 10)).toBe(50);
    expect(burnBarPercent(14.4, 10)).toBe(100);
    expect(burnBarPercent(1, 3)).toBe(33.3);
  });

  it("is an empty bar without a usable rate", () => {
    expect(burnBarPercent(null, 10)).toBe(0);
    expect(burnBarPercent(0, 10)).toBe(0);
    expect(burnBarPercent(Number.NaN, 10)).toBe(0);
    expect(burnBarPercent(2, 0)).toBe(0);
  });
});

describe("budgetColor", () => {
  it("maps each state to a different token", () => {
    const colors = (["ok", "low", "spent", "none"] as const).map(budgetColor);
    expect(new Set(colors).size).toBe(4);
    expect(budgetColor("spent")).toBe("--destructive");
  });
});

describe("summarizeSlos", () => {
  const slo = (
    remainingFraction: number | null,
    burn1h: number | null,
    breached = false,
  ) => ({
    status: {
      totalRequests: 1,
      goodRequests: 1,
      badRequests: 0,
      attainment: 1,
      errorBudget: {
        totalRequests: 1,
        remainingRequests: 1,
        remainingFraction,
      },
      burnRate: { "1h": burn1h, "6h": null },
      breached,
    },
  });

  it("counts, finds the lowest budget and the worst burn rate", () => {
    expect(
      summarizeSlos([slo(0.5, 2), slo(-1.5, 14.4, true), slo(null, null)]),
    ).toEqual({ count: 3, breached: 1, lowestBudget: -1.5, worstBurn1h: 14.4 });
  });

  it("has no lowest budget or burn rate without data", () => {
    expect(summarizeSlos([])).toEqual({
      count: 0,
      breached: 0,
      lowestBudget: null,
      worstBurn1h: null,
    });
  });
});
