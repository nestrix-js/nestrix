import { describe, expect, it } from "vitest";
import {
  addHistograms,
  bucketIndex,
  emptyHistogram,
  estimateQuantile,
  HISTOGRAM_BUCKETS,
  HISTOGRAM_UPPER_BOUNDS_MS,
} from "../../src/storage/histogram.js";

// The embedded route statistics, loaded from source (not a dependency of the server): both
// backends must bucket and estimate alike, so a change to one without the other fails here.
const embeddedPath = new URL(
  "../../../../packages/nestjs/src/stats/route-stats.ts",
  import.meta.url,
).href;

interface Embedded {
  HISTOGRAM_BUCKETS: number;
  HISTOGRAM_UPPER_BOUNDS_MS: readonly number[];
  bucketIndex(ms: number): number;
  quantile(hist: Uint32Array, total: number, q: number, max: number): number;
}

describe("rollup histogram", () => {
  it("has the embedded route statistics' bounds, buckets and estimates", async () => {
    const embedded = (await import(embeddedPath)) as Embedded;
    expect(HISTOGRAM_BUCKETS).toBe(embedded.HISTOGRAM_BUCKETS);
    expect(HISTOGRAM_UPPER_BOUNDS_MS).toEqual(
      embedded.HISTOGRAM_UPPER_BOUNDS_MS,
    );
    const samples = [
      -1,
      0,
      0.5,
      1,
      1.0001,
      3,
      14.7,
      20,
      99.9,
      1234,
      59_999,
      60_000,
      60_001,
      1e9,
      Number.NaN,
    ];
    for (const ms of samples)
      expect(bucketIndex(ms), String(ms)).toBe(embedded.bucketIndex(ms));

    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const hist = emptyHistogram();
    let max = 0;
    for (let i = 0; i < 500; i++) {
      const ms = Math.exp(rand() * 9); // 1 ms to about 8 s
      hist[bucketIndex(ms)]++;
      if (ms > max) max = ms;
    }
    for (const q of [0.5, 0.95, 0.99]) {
      expect(estimateQuantile(hist, 500, q, max)).toBe(
        embedded.quantile(Uint32Array.from(hist), 500, q, max),
      );
    }
  });

  it("adds element-wise and estimates 0 for an empty histogram", () => {
    const a = emptyHistogram();
    a[3] = 2;
    const b = emptyHistogram();
    b[3] = 1;
    b[29] = 4;
    expect(addHistograms(a, b)[3]).toBe(3);
    expect(a[29]).toBe(4);
    expect(estimateQuantile(emptyHistogram(), 0, 0.5, 0)).toBe(0);
  });
});
