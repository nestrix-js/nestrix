import { describe, expect, it } from "vitest";

import {
  bannerHeadline,
  omittedLabel,
  splitLine,
  summarizeDropped,
} from "@/lib/trace-omitted";

describe("summarizeDropped", () => {
  it("is undefined when absent or zero", () => {
    expect(summarizeDropped(undefined)).toBeUndefined();
    expect(
      summarizeDropped({ total: 0, byKind: {}, byServer: 0 }),
    ).toBeUndefined();
  });

  it("splits app and server, orders kinds like the Overview and uses its labels", () => {
    const s = summarizeDropped({
      total: 12,
      byKind: { other: 1, redis: 2, db: 4, odd: 0, mystery: 1 },
      byServer: 4,
    });
    expect(s?.app).toBe(8);
    expect(s?.server).toBe(4);
    expect(s?.kinds).toEqual([
      { key: "db", label: "Database", count: 4 },
      { key: "redis", label: "Redis", count: 2 },
      { key: "other", label: "Other", count: 1 },
      { key: "mystery", label: "mystery", count: 1 },
    ]);
  });

  it("clamps a server count above the total", () => {
    expect(summarizeDropped({ total: 3, byKind: {}, byServer: 9 })?.app).toBe(
      0,
    );
  });
});

describe("texts", () => {
  it("pluralises", () => {
    expect(omittedLabel(1)).toBe("(omitted 1 span)");
    expect(omittedLabel(5)).toBe("(omitted 5 spans)");
    expect(bannerHeadline(1)).toContain("1 more span that was counted");
    expect(bannerHeadline(2)).toContain("2 more spans that were counted");
  });

  it("names only the non-zero side", () => {
    const base = { total: 10, kinds: [] };
    expect(splitLine({ ...base, app: 10, server: 0 })).toBe(
      "10 over the app's span limit",
    );
    expect(splitLine({ ...base, app: 0, server: 10 })).toBe(
      "10 over the server's",
    );
    expect(splitLine({ ...base, app: 6, server: 4 })).toBe(
      "6 over the app's span limit, 4 over the server's",
    );
  });
});
