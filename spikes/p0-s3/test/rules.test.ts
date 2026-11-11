// Review fixes 6 and 9: the outbound rules and the processor lifecycle rule.
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
  console.log(`[${file} ${which ?? ""} node ${r.node}]`, JSON.stringify(r));
  return r;
}

describe("outbound: suppress-tracing key and no-parent rule", () => {
  it("node:http and fetch: span + traceparent only with an active, unsuppressed parent", () => {
    const r = run("http-rules.mjs");
    const header = Object.fromEntries(
      r.seen.map((s: { path: string; traceparent: string | null }) => [
        s.path,
        s.traceparent,
      ]),
    );
    expect(header["/with-parent/http"]).toMatch(/^00-/);
    expect(header["/with-parent/fetch"]).toMatch(/^00-/);
    for (const p of [
      "/suppressed/http",
      "/suppressed/fetch",
      "/no-parent/http",
      "/no-parent/fetch",
      "/export",
    ]) {
      expect(header[p]).toBeNull();
    }
    expect(r.clientSpans.sort()).toEqual(
      ["/with-parent/fetch", "/with-parent/http"].sort(),
    );
    // The BatchSpanProcessor's own export request, sent while a span was active, is
    // stopped by the SDK's suppressTracing around export.
    expect(r.clientSpansDuringExport).toBe(0);
    expect(r.httpSkips).toEqual({ suppressed: 2, noParent: 1 });
  });
});

describe("processor lifecycle: forceFlush and shutdown never reject", () => {
  it("control: an unguarded rejecting processor rejects the host's provider calls", () => {
    const r = run("q2-lifecycle.cjs", "naive-reject");
    expect(r.forceFlush).toBe("rejected: naive forceFlush");
    expect(r.shutdown).toBe("rejected: naive shutdown");
  });

  it("nestrixSpanProcessor with a fault in its flush/shutdown work: the host's calls resolve", () => {
    const r = run("q2-lifecycle.cjs", "nestrix-fault");
    expect(r.forceFlush).toBe("resolved");
    expect(r.shutdown).toBe("resolved");
    expect(r.exported).toBe(1);
  });
});
