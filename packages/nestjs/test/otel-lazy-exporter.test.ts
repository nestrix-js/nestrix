// The OTLP exporter graph (exporter-trace-otlp-http and sdk-metrics, ~110 files) loads
// only when export is on, and a span that ends before it has loaded is still exported.
// Each case runs in a child process, because only a fresh process has an empty module
// cache; the child records every module Node loads (test/fixtures/otel-lazy-child.mjs).
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { startReceiver } from "./otel-helpers.js";

const run = promisify(execFile);

async function runChild(arg: string) {
  const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
  const strip = (process.features as { typescript?: unknown }).typescript
    ? []
    : ["--experimental-strip-types"];
  const { stdout } = await run(
    process.execPath,
    [
      ...strip,
      "--no-warnings",
      "--import",
      `${fixtures}ts-hooks.mjs`,
      `${fixtures}otel-lazy-child.mjs`,
      arg,
    ],
    { timeout: 20_000 },
  );
  return JSON.parse(stdout) as {
    exporterModules: number;
    counters: { exportedSpans: number };
  };
}

describe("lazy OTLP exporter", () => {
  it("does not load the exporter graph with export off", async () => {
    const result = await runChild("off");
    expect(result.exporterModules).toBe(0);
  });

  it("loads it with export on, and exports a span that ended before it loaded, through a shutdown that began while it loaded", async () => {
    const receiver = await startReceiver();
    try {
      const result = await runChild(receiver.url);
      // The hook sees the graph, so the "0" above is not a blind spot.
      expect(result.exporterModules).toBeGreaterThan(10);
      expect(receiver.spans.map((s) => s.name)).toEqual(["early"]);
      expect(result.counters.exportedSpans).toBe(1);
    } finally {
      await receiver.close();
    }
  });
});
