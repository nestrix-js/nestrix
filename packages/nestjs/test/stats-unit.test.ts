// No global state. Unit tests for the route statistics store (P2-04).
import { describe, expect, it } from "vitest";
// Type-only, from the built declarations: `@nestrix-js/nestjs` has no dependency on the private
// protocol package (see src/stats/route-stats.ts). Drift between the two fails `tsc`.
import type {
  RouteSeriesPoint,
  RouteStats,
  RouteStatsResponse,
} from "../../protocol/dist/index.js";
import {
  BUCKET_MS,
  bucketIndex,
  HISTOGRAM_BUCKETS,
  HISTOGRAM_UPPER_BOUNDS_MS,
  MAX_ROUTE_KEYS,
  OTHER_METHOD,
  OTHER_ROUTE,
  type RouteSeriesPointResult,
  RouteStatistics,
  type RouteStatsResponseResult,
  type RouteStatsResult,
} from "../src/stats/route-stats.js";

// Both directions: what `query()` returns is a protocol response, and nothing the protocol
// requires is missing here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const drift: [
  Same<RouteStatsResponseResult, RouteStatsResponse>,
  Same<RouteStatsResult, RouteStats>,
  Same<RouteSeriesPointResult, RouteSeriesPoint>,
] = [true, true, true];

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0); // a minute boundary

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank quantile, the same rank rule the histogram uses. */
function exact(sorted: number[], q: number): number {
  return sorted[Math.max(1, Math.ceil(q * sorted.length)) - 1] as number;
}

describe("histogram buckets", () => {
  it("has 30 log-spaced buckets from 1 ms to 60 s", () => {
    expect(HISTOGRAM_BUCKETS).toBe(30);
    expect(HISTOGRAM_UPPER_BOUNDS_MS[0]).toBe(1);
    expect(HISTOGRAM_UPPER_BOUNDS_MS.at(-1)).toBe(60_000);
    const ratios = HISTOGRAM_UPPER_BOUNDS_MS.slice(1).map(
      (b, i) => b / (HISTOGRAM_UPPER_BOUNDS_MS[i] as number),
    );
    for (const r of ratios) expect(r).toBeCloseTo(ratios[0] as number, 9);
  });

  it("places each value in (B[i-1], B[i]], including exactly at the bounds", () => {
    expect(bucketIndex(0)).toBe(0);
    expect(bucketIndex(1)).toBe(0);
    expect(bucketIndex(60_000)).toBe(28);
    expect(bucketIndex(60_000.001)).toBe(29);
    expect(bucketIndex(1e9)).toBe(29);
    for (let i = 1; i < HISTOGRAM_UPPER_BOUNDS_MS.length; i++) {
      const b = HISTOGRAM_UPPER_BOUNDS_MS[i] as number;
      const prev = HISTOGRAM_UPPER_BOUNDS_MS[i - 1] as number;
      expect(bucketIndex(b)).toBe(i);
      expect(bucketIndex(prev * 1.000001)).toBe(i);
    }
  });

  it("puts NaN, negatives and infinities in an end bucket without throwing", () => {
    expect(bucketIndex(Number.NaN)).toBe(0);
    expect(bucketIndex(-5)).toBe(0);
    expect(bucketIndex(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(bucketIndex(Number.POSITIVE_INFINITY)).toBe(29);
  });
});

describe("percentiles", () => {
  const distributions: Record<string, (r: () => number) => number> = {
    // Log-normal around ~20 ms with a long tail.
    lognormal: (r) => {
      const u = Math.max(r(), 1e-12);
      const v = r();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      return Math.exp(3 + 1.2 * z);
    },
    uniform: (r) => r() * 500,
    bimodal: (r) => (r() < 0.9 ? 2 + r() * 3 : 800 + r() * 400),
    "sub-millisecond": (r) => r() * 0.9,
    "beyond 60 s": (r) => 61_000 + r() * 30_000,
    constant: () => 42,
  };

  for (const [name, draw] of Object.entries(distributions)) {
    it(`p50/p95/p99 are within one bucket of the exact values: ${name}`, () => {
      const stats = new RouteStatistics(T0);
      const r = rng(name.length * 7919);
      const values: number[] = [];
      for (let i = 0; i < 5000; i++) {
        const v = draw(r);
        values.push(v);
        stats.record("GET", "/d", v, false, T0 + 1000);
      }
      values.sort((a, b) => a - b);
      const [route] = stats.query(15, T0 + 2000).routes;
      expect(route?.count).toBe(5000);
      const got = {
        p50: route?.p50Ms as number,
        p95: route?.p95Ms as number,
        p99: route?.p99Ms as number,
      };
      const want = {
        p50: exact(values, 0.5),
        p95: exact(values, 0.95),
        p99: exact(values, 0.99),
      };
      for (const k of ["p50", "p95", "p99"] as const) {
        const diff = Math.abs(bucketIndex(got[k]) - bucketIndex(want[k]));
        expect(
          diff,
          `${k}: got ${got[k]}, exact ${want[k]}`,
        ).toBeLessThanOrEqual(1);
      }
      expect(route?.maxMs).toBeCloseTo(values.at(-1) as number, 2);
      expect(got.p99).toBeLessThanOrEqual(route?.maxMs as number);
      // The per-minute points use the same estimator.
      const point = route?.series.find((p) => p.count > 0);
      expect(point?.p50Ms).toBe(got.p50);
      expect(point?.p95Ms).toBe(got.p95);
    });
  }
});

describe("keys", () => {
  it("tracks 500 keys and counts the 501st and later under `other`", () => {
    const stats = new RouteStatistics(T0);
    for (let i = 0; i < MAX_ROUTE_KEYS; i++) {
      stats.record("GET", `/r/${i}`, 5, false, T0);
    }
    expect(stats.keyCount).toBe(500);
    stats.record("GET", "/r/500", 5, false, T0); // the 501st key
    stats.record("POST", "/r/0", 5, true, T0); // a new method is a new key too
    stats.record("GET", "/r/0", 5, false, T0); // an existing key still counts as itself
    expect(stats.keyCount).toBe(500);
    const { routes } = stats.query(60, T0);
    expect(routes).toHaveLength(501);
    const other = routes.find((r) => r.route === OTHER_ROUTE);
    expect(other).toMatchObject({
      method: OTHER_METHOD,
      count: 2,
      errors: 1,
    });
    expect(routes.find((r) => r.route === "/r/0")?.count).toBe(2);
    expect(routes.some((r) => r.route === "/r/500")).toBe(false);
    // Ordered by count, highest first.
    expect(routes[0]?.count).toBe(2);
  });
});

describe("time window", () => {
  it("returns one point per minute, aligned to minute starts, with percentiles only where there are requests", () => {
    const stats = new RouteStatistics(T0);
    stats.record("GET", "/a", 10, false, T0 + 5_000);
    stats.record("GET", "/a", 20, true, T0 + 3 * BUCKET_MS + 1);
    const now = T0 + 4 * BUCKET_MS + 30_000;
    const res: RouteStatsResponse = stats.query(15, now);
    expect(res.windowMinutes).toBe(15);
    expect(res.bucketMs).toBe(60_000);
    expect(res.toUnixMs).toBe(now);
    expect(res.fromUnixMs).toBe(T0 + 4 * BUCKET_MS - 14 * BUCKET_MS);
    const route = res.routes[0] as RouteStats;
    expect(route).toMatchObject({
      method: "GET",
      route: "/a",
      count: 2,
      errors: 1,
    });
    expect(route.series).toHaveLength(15);
    expect(route.series.map((p) => p.timeUnixMs)).toEqual(
      Array.from({ length: 15 }, (_, i) => res.fromUnixMs + i * BUCKET_MS),
    );
    const nonEmpty = route.series.filter((p) => p.count > 0);
    expect(nonEmpty.map((p) => p.timeUnixMs)).toEqual([T0, T0 + 3 * BUCKET_MS]);
    for (const p of route.series) {
      if (p.count === 0) {
        expect(p).toEqual({ timeUnixMs: p.timeUnixMs, count: 0, errors: 0 });
      } else {
        expect(p.p50Ms).toBeTypeOf("number");
        expect(p.p95Ms).toBeTypeOf("number");
      }
    }
  });

  it("drops minutes that left the window, and clears a slot reused an hour later", () => {
    const stats = new RouteStatistics(T0);
    stats.record("GET", "/a", 10, false, T0);
    expect(stats.query(15, T0 + 14 * BUCKET_MS).routes).toHaveLength(1);
    expect(stats.query(15, T0 + 15 * BUCKET_MS).routes).toHaveLength(0);
    expect(stats.query(60, T0 + 59 * BUCKET_MS).routes).toHaveLength(1);
    // Same ring slot, 60 minutes later: the old count must not leak into it.
    stats.record("GET", "/a", 30, false, T0 + 60 * BUCKET_MS);
    const [route] = stats.query(60, T0 + 60 * BUCKET_MS).routes;
    expect(route?.count).toBe(1);
    expect(route?.maxMs).toBe(30);
  });

  it("clamps the window to 1..60 minutes", () => {
    const stats = new RouteStatistics(T0);
    expect(stats.query(0, T0).windowMinutes).toBe(1);
    expect(stats.query(500, T0).windowMinutes).toBe(60);
    expect(stats.query(Number.NaN, T0).windowMinutes).toBe(1);
  });
});

describe("robustness", () => {
  it("never throws on malformed input, and ignores a non-finite time", () => {
    const stats = new RouteStatistics(T0);
    expect(() => {
      stats.record("GET", "/x", Number.NaN, false, T0);
      stats.record("GET", "/x", -10, false, T0);
      stats.record("GET", "/x", Number.POSITIVE_INFINITY, false, T0);
      stats.record("GET", "/x", 5, false, Number.NaN);
      stats.record("GET", "/x", 5, false, Number.POSITIVE_INFINITY);
      stats.query(15, Number.NaN);
    }).not.toThrow();
    const [route] = stats.query(15, T0).routes;
    expect(route?.count).toBe(3);
    expect(route?.maxMs).toBe(0);
  });

  it("matches the protocol types (compile-time check)", () => {
    expect(drift).toEqual([true, true, true]);
  });
});
