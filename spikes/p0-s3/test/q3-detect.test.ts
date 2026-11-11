import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { NODE, SPIKE_DIR, scenario } from "./helpers.ts";

function run(file: string, mode: string) {
  const out = execFileSync(NODE, [scenario(file)], {
    cwd: SPIKE_DIR,
    env: { ...process.env, NODE_OPTIONS: "", S3_HOST: mode },
    encoding: "utf8",
  });
  const m = out.match(/RESULT (.*)\n/);
  if (!m) throw new Error(out);
  const r = JSON.parse(m[1]);
  // In every mode, injecting a valid span context agrees with propagation.fields().
  expect(r.probes.propagatorByInject).toBe(r.probes.propagatorByFields);
  return r;
}

const DUP = (api: string) =>
  `Error: @opentelemetry/api: Attempted duplicate registration of API: ${api}`;

describe("Q3: detect host globals without deprecated API", () => {
  for (const file of ["q3-detect.mjs", "q3-detect.cjs"]) {
    it(`${file}: nothing registered`, () => {
      const r = run(file, "none");
      console.log(`[Q3 ${file} none]`, JSON.stringify(r.probes));
      expect(r.probes).toEqual({
        contextManagerSync: false,
        contextManagerAsync: false,
        propagatorFields: [],
        propagatorByFields: false,
        propagatorByInject: false,
        providerByProbeSpan: false,
      });
      expect(r.attempts).toEqual({
        setGlobalTracerProvider: true,
        setGlobalContextManager: true,
        setGlobalPropagator: true,
      });
      expect(r.attemptDiag).toEqual([]);
    });

    it(`${file}: host registered provider, ALS context manager and W3C propagator`, () => {
      const r = run(file, "all");
      console.log(
        `[Q3 ${file} all]`,
        JSON.stringify(r.probes),
        "probe diag",
        JSON.stringify(r.probeDiag),
        "attempt diag",
        JSON.stringify(r.attemptDiag),
        "probe spans exported",
        JSON.stringify(r.probeSpansInHostExporter),
      );
      expect(r.probes).toEqual({
        contextManagerSync: true,
        contextManagerAsync: true,
        propagatorFields: ["traceparent", "tracestate"],
        propagatorByFields: true,
        propagatorByInject: true,
        providerByProbeSpan: true,
      });
      // Probes are silent; the probe span is a visible side effect.
      expect(r.probeDiag).toEqual([]);
      expect(r.probeSpansInHostExporter).toEqual(["nestrix.detect"]);
      // Trying to register returns false for each, and logs an error per attempt.
      expect(r.attempts).toEqual({
        setGlobalTracerProvider: false,
        setGlobalContextManager: false,
        setGlobalPropagator: false,
      });
      expect(r.attemptDiag).toEqual([
        DUP("trace"),
        DUP("context"),
        DUP("propagation"),
      ]);
    });

    it(`${file}: host registered only a propagator`, () => {
      const r = run(file, "propagator");
      expect(r.probes.contextManagerSync).toBe(false);
      expect(r.probes.propagatorByFields).toBe(true);
      expect(r.probes.providerByProbeSpan).toBe(false);
    });

    it(`${file}: host registered only a context manager`, () => {
      const r = run(file, "context");
      expect(r.probes.contextManagerSync).toBe(true);
      expect(r.probes.contextManagerAsync).toBe(true);
      expect(r.probes.propagatorByFields).toBe(false);
    });

    it(`${file}: host registered a sync-only StackContextManager`, () => {
      const r = run(file, "stack-context");
      console.log(`[Q3 ${file} stack-context]`, JSON.stringify(r.probes));
      expect(r.probes.contextManagerSync).toBe(true);
      expect(r.probes.contextManagerAsync).toBe(false);
      // And it cannot be replaced: the slot is taken.
      expect(r.attempts.setGlobalContextManager).toBe(false);
    });
  }

  it("the API has no public getter for the context manager or propagator", () => {
    const r = run("q3-detect.mjs", "none");
    console.log("[Q3 getters]", JSON.stringify(r.publicGetters));
    const publicNames = (names: string[]) =>
      names.filter((n) => !n.startsWith("_") && n !== "constructor");
    expect(publicNames(r.publicGetters.contextApi).sort()).toEqual(
      [
        "active",
        "attach",
        "bind",
        "disable",
        "setGlobalContextManager",
        "with",
      ].sort(),
    );
    expect(publicNames(r.publicGetters.propagationApi).sort()).toEqual(
      ["disable", "extract", "fields", "inject", "setGlobalPropagator"].sort(),
    );
  });
});
