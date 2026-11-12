import { describe, expect, it } from "vitest";

import { sparklinePoints } from "@/views/dependencies/sparkline";

describe("sparklinePoints", () => {
  it("is empty without values", () => {
    expect(sparklinePoints([], 100, 20)).toBe("");
  });

  it("puts the maximum at the top and zero at the bottom", () => {
    // width 100, height 20, pad 2: x from 2 to 98; y from 18 (0) to 2 (max).
    expect(sparklinePoints([0, 5, 10], 100, 20)).toBe(
      "2.0,18.0 50.0,10.0 98.0,2.0",
    );
  });

  it("draws an all-zero series flat at the bottom", () => {
    expect(sparklinePoints([0, 0], 100, 20)).toBe("2.0,18.0 98.0,18.0");
  });

  it("keeps a single value inside the box", () => {
    expect(sparklinePoints([7], 100, 20)).toBe("2.0,2.0");
  });
});
