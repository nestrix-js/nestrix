import { describe, expect, it } from "vitest";

import { sourceKindOf, withoutPageSource } from "@/components/kit/page-source";

describe("source kinds", () => {
  it("knows the standard wordings", () => {
    expect(sourceKindOf("from sampled traces")).toBe("traces");
    expect(sourceKindOf("traces")).toBe("traces");
    expect(sourceKindOf("counted before sampling")).toBe("stats");
    expect(sourceKindOf("before sampling")).toBe("stats");
    expect(sourceKindOf("estimated from sampled traces")).toBeNull();
    expect(sourceKindOf(undefined)).toBeNull();
  });
});

describe("a card's source line against its page", () => {
  it("drops a line the page header already says", () => {
    expect(withoutPageSource("from sampled traces", "traces")).toBe("");
    expect(withoutPageSource("counted before sampling", "stats")).toBe("");
  });
  it("drops only that part of a longer line", () => {
    expect(
      withoutPageSource("5xx or thrown · from sampled traces", "traces"),
    ).toBe("5xx or thrown");
  });
  it("keeps a line that differs from its page", () => {
    expect(withoutPageSource("estimated from sampled traces", "stats")).toBe(
      "estimated from sampled traces",
    );
    expect(withoutPageSource("from sampled traces", "stats")).toBe(
      "from sampled traces",
    );
  });
  it("keeps everything when the page states no single source", () => {
    expect(withoutPageSource("from sampled traces", null)).toBe(
      "from sampled traces",
    );
  });
});
