// P15-02: the weekday x hour grid and the per-release rows.
// `apps/server/test/query/error-insights-unit.test.ts` runs the same cases against the standalone
// server's copy of the module.
import { describe, expect, it } from "vitest";
import {
  addToHeatmap,
  assembleInsights,
  cellOf,
  emptyHeatmap,
  INSIGHTS_MS,
} from "../src/store/error-insights.js";

describe("cellOf", () => {
  it("numbers Monday 0 to Sunday 6 and the hour in UTC", () => {
    // 2026-11-09 is a Monday, 2026-11-15 a Sunday.
    expect(cellOf(Date.UTC(2026, 10, 9, 0, 0))).toEqual({
      weekday: 0,
      hour: 0,
    });
    expect(cellOf(Date.UTC(2026, 10, 12, 13, 59))).toEqual({
      weekday: 3,
      hour: 13,
    });
    expect(cellOf(Date.UTC(2026, 10, 15, 23, 59))).toEqual({
      weekday: 6,
      hour: 23,
    });
  });
});

describe("heatmap", () => {
  it("counts into the right cell and ignores a time that is not a number", () => {
    const h = emptyHeatmap();
    addToHeatmap(h, Date.UTC(2026, 10, 12, 13, 5));
    addToHeatmap(h, Date.UTC(2026, 10, 12, 13, 55));
    addToHeatmap(h, Number.NaN);
    expect(h).toHaveLength(7);
    expect(h.every((row) => row.length === 24)).toBe(true);
    expect(h[3]?.[13]).toBe(2);
    expect(h.flat().reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe("assembleInsights", () => {
  const now = Date.UTC(2026, 10, 12, 12, 0);
  const release = (
    name: string,
    events: number,
    ago: number,
    requests?: number,
  ) => ({
    release: name,
    events,
    requests,
    firstSeenUnixMs: now - ago,
  });

  it("computes errors per 1,000 requests and leaves it out without requests", () => {
    const r = assembleInsights({
      now,
      heatmap: emptyHeatmap(),
      coveredFromUnixMs: now - 1000,
      releases: [release("1.0.0", 3, 5000, 1500), release("1.1.0", 4, 1000, 0)],
    });
    expect(r.releases[0]).toMatchObject({
      release: "1.0.0",
      requests: 1500,
      per1000Requests: 2,
    });
    expect(r.releases[1]?.requests).toBeUndefined();
    expect(r.releases[1]?.per1000Requests).toBeUndefined();
  });

  it("keeps the newest 8 releases, oldest first", () => {
    const releases = Array.from({ length: 10 }, (_, i) =>
      release(`r${i}`, 1, (10 - i) * 1000),
    );
    const r = assembleInsights({
      now,
      heatmap: emptyHeatmap(),
      coveredFromUnixMs: now,
      releases,
    });
    expect(r.releases.map((x) => x.release)).toEqual([
      "r2",
      "r3",
      "r4",
      "r5",
      "r6",
      "r7",
      "r8",
      "r9",
    ]);
  });

  it("totals the grid and clamps the covered range into the 7 days", () => {
    const h = emptyHeatmap();
    addToHeatmap(h, now - 1000);
    addToHeatmap(h, now - 2000);
    const r = assembleInsights({
      now,
      heatmap: h,
      coveredFromUnixMs: now - 30 * 24 * 3_600_000,
      releases: [],
    });
    expect(r).toMatchObject({
      total: 2,
      zone: "UTC",
      fromUnixMs: now - INSIGHTS_MS,
      toUnixMs: now,
      coveredFromUnixMs: now - INSIGHTS_MS,
    });
  });
});
