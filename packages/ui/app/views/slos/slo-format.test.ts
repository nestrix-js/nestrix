import { describe, expect, it } from "vitest";

import {
  budgetBarPercent,
  budgetState,
  describeBudget,
  emptyForm,
  formatBurnRate,
  formatPercent,
  toRequest,
} from "@/views/slos/slo-format";

describe("formatPercent", () => {
  it("shows the decimals a value needs, at most three", () => {
    expect(formatPercent(0.999)).toBe("99.9%");
    expect(formatPercent(0.99987)).toBe("99.987%");
    expect(formatPercent(0.95)).toBe("95%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(null)).toBe("-");
  });

  it("never rounds a miss up to 100% or a hit down to 0%", () => {
    expect(formatPercent(0.9999999)).toBe("99.999%");
    expect(formatPercent(0.0000001)).toBe("0.001%");
  });
});

describe("burn rate and budget text", () => {
  it("formats burn rates", () => {
    expect(formatBurnRate(14.4)).toBe("14.4x");
    expect(formatBurnRate(2)).toBe("2x");
    expect(formatBurnRate(250.4)).toBe("250x");
    expect(formatBurnRate(null)).toBe("-");
  });

  it("classifies the remaining budget", () => {
    expect(budgetState(null)).toBe("none");
    expect(budgetState(0.8)).toBe("ok");
    expect(budgetState(0.2)).toBe("low");
    expect(budgetState(0)).toBe("spent");
    expect(budgetState(-3)).toBe("spent");
  });

  it("keeps the bar between empty and full", () => {
    expect(budgetBarPercent(0.5)).toBe(50);
    expect(budgetBarPercent(-1.5)).toBe(0);
    expect(budgetBarPercent(1)).toBe(100);
    expect(budgetBarPercent(null)).toBe(0);
  });

  it("says what is left or how far over", () => {
    expect(describeBudget(0.984)).toBe("98.4% of the budget left");
    expect(describeBudget(-0.4)).toBe("budget overspent by 40%");
    expect(describeBudget(null)).toBe("no requests in the window");
  });
});

describe("form to request", () => {
  const form = { ...emptyForm("shop"), name: " Orders " };

  it("builds an availability request from percentages", () => {
    expect(toRequest({ ...form, objectivePercent: "99.9" })).toEqual({
      ok: true,
      body: {
        name: "Orders",
        service: "shop",
        route: null,
        kind: "availability",
        objective: 0.999,
        windowDays: 30,
      },
    });
  });

  it("a latency request carries its threshold, the route is trimmed", () => {
    expect(
      toRequest({
        ...form,
        kind: "latency",
        latencyThresholdMs: "300",
        route: " /orders ",
        windowDays: "7",
      }),
    ).toMatchObject({
      ok: true,
      body: {
        kind: "latency",
        latencyThresholdMs: 300,
        route: "/orders",
        windowDays: 7,
      },
    });
  });

  it.each([
    [{ name: "" }, "name"],
    [{ service: " " }, "service"],
    [{ objectivePercent: "100" }, "objective"],
    [{ objectivePercent: "abc" }, "objective"],
    [{ kind: "latency" as const, latencyThresholdMs: "" }, "latency"],
    [{ kind: "latency" as const, latencyThresholdMs: "-5" }, "latency"],
  ])("refuses %j", (change, word) => {
    const r = toRequest({ ...form, ...change });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message.toLowerCase()).toContain(word);
  });
});
