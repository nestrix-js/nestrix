// Q2: a capture next to an attached debugger, an in-process Session (APM), and another capture.
// Q4: nothing deoptimised and responses unchanged after a capture; Debugger.enable not needed.
import { describe, expect, it } from "vitest";
import { hotRouteLine, probe, type Row } from "./run.ts";

const ok = { problems: [], esm: true, cjs: true };

// Retried: these attach a debugger and time samples, which flakes when the whole workspace runs at once.
describe("Q2: interference", { retry: 2 }, () => {
  it("A: with a debugger attached and profiling, both captures and the debugger's profile are valid", async () => {
    const [r] = (await probe("q2-interference.mjs", ["A"])) as Row[];
    expect(r.v8Capture).toMatchObject(ok);
    expect(r.sessionCapture).toMatchObject({ ...ok, intervalError: null });
    expect(r.debuggerProfile).toMatchObject(ok);
    // The sampling rates are checked phase by phase in the crosstalk test below (a median here
    // is skewed by the start burst of the first profile in a process, which is the debugger's).
    expect(r.v8Capture.medianDeltaUs).toBeLessThan(3000);
    expect(r.debuggerEvaluate).toBe(42);
  }, 30_000);

  it("B: a debugger pause in the middle of a v8 capture leaves a valid profile", async () => {
    const [r] = (await probe("q2-interference.mjs", ["B"])) as Row[];
    expect(r.pausedAt).toBeTruthy();
    expect(r.capture).toMatchObject(ok);
  }, 30_000);

  it("C: an in-process Session profiling at 10 ms is not disturbed (not even by our Profiler.disable)", async () => {
    const [r] = (await probe("q2-interference.mjs", ["C"])) as Row[];
    expect(r.v8Capture).toMatchObject(ok);
    expect(r.sessionCapture).toMatchObject(ok);
    expect(r.apm).toMatchObject(ok);
  }, 30_000);

  it.each(["session", "v8"])(
    "crosstalk: a 10 ms profiler (%s) keeps its rate while a 1 ms capture runs beside it",
    async (kind) => {
      const [r] = (await probe("q2-crosstalk.mjs", [kind])) as Row[];
      const { phaseBoth, phaseAfter } = r.profilerA_10ms;
      // 600 ms phases: about 40 samples at the effective 13-15 ms. phaseAlone is left out: when
      // A is the first profile in the process its start burst (about 100 samples) lands there.
      expect(phaseBoth).toBeGreaterThan(25);
      expect(phaseBoth).toBeLessThan(65);
      expect(Math.abs(phaseBoth - phaseAfter)).toBeLessThan(15);
      expect(r.ours_1ms.phaseBoth).toBeGreaterThan(300);
    },
    20_000,
  );

  it("D: v8.startCpuProfile does not refuse a second concurrent capture; stop() twice returns undefined", async () => {
    const [r] = (await probe("q2-interference.mjs", ["D"])) as Row[];
    expect(r.error).toBeNull();
    expect(r.first).toMatchObject(ok);
    expect(r.second).toMatchObject(ok);
    expect(r.stopAgain).toBeNull();
  }, 30_000);

  it("E: inspector.url() is the only public signal, and only for an open debugger port", async () => {
    const [r] = (await probe("q2-interference.mjs", ["E"])) as Row[];
    expect(r.without).toBeNull();
    expect(r.withInspect).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/<uuid>$/);
  }, 30_000);
});

describe("Q4: after a capture", () => {
  it("optimisation status and responses are unchanged; the profile needs no Debugger.enable", async () => {
    const rows = (await probe(
      "q4-after.mjs",
      ["v8,inspector,inspector+debugger"],
      {
        env: { P7_N: "400" },
      },
    )) as Row[];
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      const { before, started, afterStop, afterPost } = r.opt;
      expect([started, afterStop, afterPost]).toEqual([before, before, before]);
      expect(r.responsesUnchanged).toBe(true);
      expect(r.profile).toMatchObject({
        problems: [],
        hotFound: true,
        line: hotRouteLine,
      });
      expect(r.profile.url).toBe("spikes/p7-s1/fixtures/app.mjs");
    }
  }, 60_000);
});
