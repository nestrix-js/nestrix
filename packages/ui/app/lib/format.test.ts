import { describe, expect, it } from "vitest";

import {
  formatDuration,
  formatRelative,
  samplingNotice,
  showsSamplingNotice,
} from "@/lib/format";

describe("sampling notice", () => {
  it("states the rate when it is below 1, with a tooltip", () => {
    const notice = samplingNotice({ owner: "nestrix", rate: 0.25 });
    expect(notice?.text).toBe("traces sampled at 25%");
    expect(notice?.title).toContain("25%");
    expect(samplingNotice({ owner: "nestrix", rate: 0.125 })?.text).toBe(
      "traces sampled at 12.5%",
    );
    expect(samplingNotice({ owner: "nestrix", rate: 0 })?.text).toBe(
      "traces sampled at 0%",
    );
  });
  it("says traces may be sampled when the host owns the sampler", () => {
    expect(samplingNotice({ owner: "host", rate: null })?.text).toBe(
      "traces may be sampled",
    );
  });
  it("says nothing at a rate of 1", () => {
    expect(samplingNotice({ owner: "nestrix", rate: 1 })).toBeNull();
  });
});

describe("where the sampling notice shows", () => {
  it("is hidden on pages that do not show sampled traces", () => {
    for (const p of [
      "/logs",
      "/runtime",
      "/metrics",
      "/slos",
      "/alerts",
      "/settings",
    ])
      expect(showsSamplingNotice(p)).toBe(false);
  });
  it("shows on the trace pages", () => {
    for (const p of ["/", "/requests", "/routes", "/route", "/traces/abc"])
      expect(showsSamplingNotice(p)).toBe(true);
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
