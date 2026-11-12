// P9-02: the pure parts of the server's route insights (no database): bucket bounds, deltas,
// joining and the release SQL.
import { describe, expect, it } from "vitest";
import {
  bucketsOf,
  compareRows,
  deltaOf,
  releaseCompareSql,
  releaseSides,
  releasesSql,
} from "../../src/query/route-insights.js";
import { HISTOGRAM_BUCKETS } from "../../src/storage/histogram.js";

describe("route insights (server, pure)", () => {
  it("lays out the 30 buckets contiguously from 0 to open-ended", () => {
    const hist = Array.from({ length: HISTOGRAM_BUCKETS }, (_, i) => i);
    const b = bucketsOf(hist);
    expect(b).toHaveLength(30);
    expect(b[0]).toMatchObject({ fromMs: 0, toMs: 1, count: 0 });
    expect(b[29]).toMatchObject({ toMs: null, count: 29 });
    expect(b[28]?.toMs).toBe(60_000);
    for (let i = 1; i < 30; i++) expect(b[i]?.fromMs).toBe(b[i - 1]?.toMs);
  });

  it("joins sides, sorts by the after count, and leaves unknown percentiles null", () => {
    const row = (route: string, count: number, p95Ms: number, errors = 0) => ({
      method: "GET",
      route,
      count,
      errors,
      p50Ms: p95Ms / 2,
      p95Ms,
    });
    const rows = compareRows(
      [row("/a", 10, 100), row("/gone", 3, 5)],
      [row("/a", 20, 250, 5), row("/new", 1, 7)],
    );
    expect(rows.map((r) => r.route)).toEqual(["/a", "/new", "/gone"]);
    expect(rows[0]?.delta).toEqual({
      count: 10,
      errorRate: 0.25,
      p50Ms: 75,
      p95Ms: 150,
    });
    expect(rows[1]?.delta.p95Ms).toBeNull();
    expect(rows[2]?.after.count).toBe(0);
    expect(
      deltaOf(
        { count: 0, errors: 0, p50Ms: 0, p95Ms: 0 },
        { count: 0, errors: 0, p50Ms: 0, p95Ms: 0 },
      ),
    ).toEqual({ count: 0, errorRate: 0, p50Ms: null, p95Ms: null });
  });

  it("builds a parameterised release query, with the service filter only when given", () => {
    const plain = releaseCompareSql("1.0", "1.1", undefined);
    expect(plain.values).toEqual([["1.0", "1.1"]]);
    expect(plain.text).toContain("percentile_disc(0.95)");
    expect(plain.text).toContain("release = ANY($1::text[])");
    expect(plain.text).not.toContain("service_name");
    // Values never reach the SQL text.
    expect(plain.text).not.toContain("1.1");
    const scoped = releaseCompareSql("1.0", "1.1", "shop");
    expect(scoped.values).toEqual([["1.0", "1.1"], "shop"]);
    expect(scoped.text).toContain("service_name = $2");
    expect(releasesSql(undefined).values).toEqual([]);
    expect(releasesSql("shop")).toMatchObject({ values: ["shop"] });
    expect(releasesSql("shop").text).toContain("service_name = $1");
  });

  it("splits release rows by release and reads numeric strings", () => {
    const base = { method: "GET", route: "/a", errors: 0 };
    const { a, b } = releaseSides(
      [
        { ...base, release: "1.0", count: 2, p50_ms: "10", p95_ms: 20 },
        { ...base, release: "1.1", count: 3, p50_ms: 11.5, p95_ms: "30" },
        { ...base, release: "x", count: 9, p50_ms: 1, p95_ms: 1 },
      ],
      "1.0",
      "1.1",
    );
    expect(a).toEqual([
      { method: "GET", route: "/a", count: 2, errors: 0, p50Ms: 10, p95Ms: 20 },
    ]);
    expect(b[0]).toMatchObject({ count: 3, p50Ms: 11.5, p95Ms: 30 });
  });
});
