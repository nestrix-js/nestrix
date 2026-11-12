import { describe, expect, it } from "vitest";

import { formatDuration, formatRelative, samplingNotice } from "@/lib/format";

describe("sampling notice", () => {
  it("says lists are sampled when the rate is below 1", () => {
    expect(samplingNotice({ owner: "nestrix", rate: 0.25 })).toBe(
      "lists are sampled",
    );
    expect(samplingNotice({ owner: "nestrix", rate: 0 })).toBe(
      "lists are sampled",
    );
  });
  it("says lists may be sampled when the host owns the sampler", () => {
    expect(samplingNotice({ owner: "host", rate: null })).toBe(
      "lists may be sampled",
    );
  });
  it("says nothing at a rate of 1", () => {
    expect(samplingNotice({ owner: "nestrix", rate: 1 })).toBeNull();
  });
});

describe("formatDuration", () => {
  it("picks a unit by magnitude", () => {
    expect(formatDuration(0.456)).toBe("0.46 ms");
    expect(formatDuration(12.34)).toBe("12.3 ms");
    expect(formatDuration(245)).toBe("245 ms");
    expect(formatDuration(2250.1)).toBe("2.25 s");
    expect(formatDuration(90_000)).toBe("1.5 min");
    expect(formatDuration(Number.NaN)).toBe("-");
  });
});

describe("formatRelative", () => {
  const now = 1_000_000_000_000;
  it("rounds to the coarsest sensible unit", () => {
    expect(formatRelative(now - 2000, now)).toBe("now");
    expect(formatRelative(now - 30_000, now)).toBe("30 seconds ago");
    expect(formatRelative(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe("3 hours ago");
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe("2 days ago");
  });
});
