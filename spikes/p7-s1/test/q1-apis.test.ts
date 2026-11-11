// Q1: the three public APIs that can profile the main thread from inside the process, each in a
// fresh process; and in a Nest app on each adapter.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hotRouteLine, probe, type Row } from "./run.ts";

describe("Q1: APIs", () => {
  it.each(["inspector", "worker", "v8"])(
    "%s: a valid profile with the ESM and CommonJS hot functions at their file and line",
    async (method) => {
      const [r] = (await probe("q1-apis.mjs", [method, "1"])) as Row[];
      expect(r.error).toBeUndefined();
      expect(r.problems).toEqual([]);
      expect(r.samples).toBeGreaterThan(100);
      // lineNumber is 0-based in the format: line 3 of each fixture.
      expect(r.esm).toMatchObject({
        found: true,
        lineNumber: 2,
        hasPositionTicks: true,
      });
      expect(r.esm.url).toMatch(/^file:\/\/\/.*\/fixtures\/hot\.mjs$/);
      expect(r.cjs).toMatchObject({
        found: true,
        lineNumber: 2,
        hasPositionTicks: true,
      });
      // CommonJS: the inspector (like node --cpu-prof) reports a file URL and string scriptIds;
      // v8.startCpuProfile reports a plain path and numeric scriptIds.
      if (method === "v8") {
        expect(r.cjs.url).toMatch(/^\/.*\/fixtures\/hot\.cjs$/);
        expect(r.esm.scriptIdType).toBe("number");
      } else {
        expect(r.cjs.url).toMatch(/^file:\/\/\/.*\/fixtures\/hot\.cjs$/);
        expect(r.esm.scriptIdType).toBe("string");
      }
      expect(r.esm.selfShare + r.cjs.selfShare).toBeGreaterThan(0.9);
    },
    20_000,
  );

  it("sampleInterval 10 ms gives samples about 10-15 ms apart after the start burst", async () => {
    const rows = (await probe("q1-apis.mjs", ["all", "10"])) as Row[];
    for (const r of rows) {
      expect(r.problems).toEqual([]);
      expect(r.medianDeltaUs).toBeGreaterThan(9000);
      expect(r.medianDeltaUs).toBeLessThan(20000);
    }
  }, 20_000);
});

// Inlined functions (V8 CPU profiler behaviour, pinned). Counted over 10 runs each on 2026-11-11,
// both hot functions attributed with their own frames: optimised during the capture 10/10;
// optimised before a first capture 6/10 ("warm,v8"); the same after a sampling heap profile 5/10
// ("heapempty,warm,v8"); optimised after an earlier CPU capture 0/10 ("v8empty,warm,v8"). Only the
// two ends are stable enough to pin.
describe("Q1: attribution of inlined functions", () => {
  it("code optimised during the capture keeps its own frames", async () => {
    for (let i = 0; i < 3; i++) {
      const [r] = (await probe("q1-repeat.mjs", ["v8"])) as Row[];
      expect(r).toMatchObject({ esm: true, cjs: true });
    }
  }, 20_000);

  it.each(["v8empty,warm,v8", "inspempty,warm,v8", "inspempty,warm,inspector"])(
    "%s: code optimised after any earlier CPU capture is mostly attributed to its inlining caller",
    async (sequence) => {
      const shares: number[] = [];
      for (let i = 0; i < 3; i++) {
        const last = ((await probe("q1-repeat.mjs", [sequence])) as Row[]).at(
          -1,
        ) as Row;
        expect(last.problems).toEqual([]);
        shares.push(last.esmShare + last.cjsShare);
      }
      // Code optimised during a capture gets above 0.9.
      expect(
        shares.filter((s) => s < 0.6).length,
        `shares ${shares}`,
      ).toBeGreaterThanOrEqual(2);
    },
    30_000,
  );
});

describe("Q3: the start pause", () => {
  it("grows with the amount of compiled code, on every capture", async () => {
    const rows = (await probe("start-cost.mjs", ["small-first"])) as Row[];
    const [small1, small2, big1, big2] = rows as Row[];
    console.log(JSON.stringify(rows));
    expect(big1.codeMB).toBeGreaterThan(10 * small1.codeMB);
    expect(big1.startMs).toBeGreaterThan(5 * small1.startMs);
    // Not a one-time cost: the next capture pays about the same.
    expect(big2.startMs).toBeGreaterThan(0.6 * big1.startMs);
    expect(small2.startMs).toBeGreaterThan(0);
    expect(big1.stopMs).toBeLessThan(50);
  }, 60_000);
});

describe("Q1: in a Nest app", () => {
  it.each(["express", "fastify", "node"])(
    "%s: v8 and inspector captures find hotRouteWork with its line; responses unchanged",
    async (adapter) => {
      const rows = (await probe("nest-capture.mjs", [adapter, "v8,inspector"], {
        env: { P7_WARM: "1000" },
      })) as Row[];
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.problems).toEqual([]);
        expect(r.responsesUnchanged).toBe(true);
        expect(r.hot).toMatchObject({ found: true, lineNumber: hotRouteLine });
        expect(r.hot.url).toMatch(/\/fixtures\/app\.mjs$/);
        // Warmed up before the first capture: the hot function is the top non-idle entry.
        const top = (r.top as string[]).filter((t) => !t.startsWith("(idle)"));
        expect(top[0]).toMatch(/^hotRouteWork /);
        // Start is a synchronous pause on the main thread (code logging); stop is short.
        expect(r.startMs).toBeLessThan(500);
        expect(r.stopMs).toBeLessThan(50);
      }
    },
    30_000,
  );
});

describe("Q2 (also): node --cpu-prof", () => {
  it("a capture inside a process started with --cpu-prof leaves its profile intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p7-s1-cpuprof-"));
    try {
      const [r] = (await probe("q1-apis.mjs", ["v8", "1"], {
        execArgv: ["--cpu-prof", `--cpu-prof-dir=${dir}`],
      })) as Row[];
      expect(r.problems).toEqual([]);
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      const whole = JSON.parse(
        readFileSync(join(dir, files[0] as string), "utf8"),
      );
      expect(whole.samples.length).toBeGreaterThan(100);
      expect(
        whole.nodes.some((n: Row) => n.callFrame.functionName === "esmHotLoop"),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
