import { describe, expect, it } from "vitest";
import { windowChoices, windowLabel } from "@/lib/windows";

describe("windows", () => {
  it("labels windows in the largest whole unit", () => {
    expect([15, 60, 360, 1440, 10_080, 43_200].map(windowLabel)).toEqual([
      "15 min",
      "60 min",
      "6 h",
      "24 h",
      "7 d",
      "30 d",
    ]);
  });

  it("offers 15 and 60 until the server says more", () => {
    expect(windowChoices(undefined).map((c) => c.value)).toEqual([15, 60]);
    expect(windowChoices([15, 60, 360, 1440]).map((c) => c.label)).toEqual([
      "15 min",
      "60 min",
      "6 h",
      "24 h",
    ]);
  });
});
