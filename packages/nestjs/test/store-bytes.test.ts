// The store's byte estimate (src/store/record.ts) against what the records really cost:
// heap growth after a forced GC while realistic spans go through a real SDK 3 provider
// into the store. Runs in a child process with --expose-gc
// (test/fixtures/store-bytes-child.mjs). Measured when calibrated (darwin-arm64, Node
// 26.13): estimate 1.14x to 1.22x the heap growth, Latin-1 and two-byte values, 2,200 and
// 10,200 traces. The band below allows for GC noise and other V8 versions, and fails if
// the estimate stops being a moderate over-estimate.
//
// The eviction case keeps 300 traces of 5,200, each with an error item. Evicted entries
// wait in the store's ordered arrays until compaction; if they kept their spans, real
// memory would exceed what the estimate accounts for. Measured: 0.86 with the release
// in `evict()`, 0.50 to 0.51 with it removed.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

async function measure(...args: string[]) {
  const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
  const strip = (process.features as { typescript?: unknown }).typescript
    ? []
    : ["--experimental-strip-types"];
  const { stdout } = await run(
    process.execPath,
    [
      ...strip,
      "--expose-gc",
      "--no-warnings",
      "--import",
      `${fixtures}ts-hooks.mjs`,
      `${fixtures}store-bytes-child.mjs`,
      ...args,
    ],
    { timeout: 60_000 },
  );
  return JSON.parse(stdout) as {
    spans: number;
    evictedTraces: number;
    estimatedBytes: number;
    heapBytes: number;
    ratio: number;
  };
}

// The ratio is a heap-growth measurement, and a loaded machine (other test files sharing the
// CPU, V8 compiling or collecting at other times) can push one sample out of band. The bounds
// are not changed. Each assertion takes the first sample inside (lower, upper) from up to three
// fresh child processes. A regression is systematic, so it is out of band in all three and
// still fails; a one-off load spike is not. If no sample is inside, the last one is returned
// and the assertions report it.
async function measureWithin(lower: number, upper: number, ...args: string[]) {
  let result = await measure(...args);
  for (let attempt = 1; attempt < 3; attempt++) {
    if (result.ratio > lower && result.ratio < upper) break;
    result = await measure(...args);
  }
  return result;
}

describe("store byte estimate", () => {
  for (const mode of ["latin1", "two-byte"]) {
    it(`over-estimates the heap moderately (${mode} values)`, async () => {
      const result = await measureWithin(1, 1.6, "3000", mode);
      expect(result.spans).toBe(3200 * 4);
      expect(result.ratio).toBeGreaterThan(1);
      expect(result.ratio).toBeLessThan(1.6);
    }, 30_000);
  }

  it("counts two bytes per character for large two-byte strings (about 8 KB each)", async () => {
    const result = await measureWithin(1, 1.6, "300", "two-byte-large");
    expect(result.spans).toBe(500 * 4);
    expect(result.ratio).toBeGreaterThan(1);
    expect(result.ratio).toBeLessThan(1.6);
  }, 30_000);

  it("releases evicted traces: retained heap stays near the estimate", async () => {
    const result = await measureWithin(0.7, 1.6, "5000", "latin1", "evict");
    expect(result.evictedTraces).toBe(4900);
    expect(result.ratio).toBeGreaterThan(0.7);
    expect(result.ratio).toBeLessThan(1.6);
  }, 30_000);
});
