import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { NODE, SPIKE_DIR, scenario } from "./helpers.ts";

function run(file: string, which?: string) {
  const out = execFileSync(NODE, [scenario(file)], {
    cwd: SPIKE_DIR,
    env: { ...process.env, NODE_OPTIONS: "", S3_CASE: which },
    encoding: "utf8",
  });
  const m = out.match(/RESULT (.*)\n/);
  if (!m) throw new Error(out);
  const r = JSON.parse(m[1]);
  console.log(`[early tracer ${r.case} node ${r.node}]`, JSON.stringify(r));
  return r;
}

describe("P0-S2 input: a tracer taken before the provider is registered", () => {
  it("one api copy: it starts recording once a provider is registered", () => {
    const r = run("early-tracer.mjs");
    expect(r.earlyBeforeRegistration).toBe(false);
    expect(r.earlyAfterRegistration).toBe(true);
    expect(r.exported).toEqual(["early-after"]);
  });

  it("CJS host, Nestrix registers through the .mjs copy: the host's early tracer stays a no-op", () => {
    const r = run("early-tracer.cjs", "cross-copy");
    expect(r).toMatchObject({
      registered: true,
      cjsEarly: false,
      cjsLate: true,
      esmEarly: true,
      esmLate: true,
    });
    expect(r.exported).toEqual(["cjs-late", "esm-early", "esm-late"]);
  });

  it("level 4: an upstream instrumentation a CJS host constructs before Nestrix registers loses its spans", () => {
    const before = run("early-instrumentation.cjs", "before");
    expect(before.instrumentationEnabled).toBe(true);
    expect(before.exported).toEqual(["server[nestrix-standin]"]);
    expect(before.clientSpanId).toBeNull();
    // The no-op tracer passes the parent through, so traceparent names the server span.
    expect(before.traceparentSpanId).toBe(before.serverSpanId);

    const after = run("early-instrumentation.cjs", "after");
    expect(after.exported).toEqual([
      "GET[@opentelemetry/instrumentation-undici]",
      "server[nestrix-standin]",
    ]);
    expect(after.clientSpanParentIsServer).toBe(true);
    expect(after.traceparentSpanId).toBe(after.clientSpanId);
  });

  it("registering through the .cjs copy instead only moves the problem to the .mjs side", () => {
    const r = run("early-tracer.cjs", "via-cjs");
    expect(r).toMatchObject({
      registered: true,
      cjsEarly: true,
      cjsLate: true,
      esmEarly: false,
      esmLate: true,
    });
  });
});
