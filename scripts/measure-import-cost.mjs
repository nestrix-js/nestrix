#!/usr/bin/env node
// Import cost of @nestrix-js/nestjs for an app that has Nestrix switched off (issue #41, D-99).
//
// Each run is a fresh `node` process with NESTRIX_ENABLED=false that imports `reflect-metadata`,
// `@nestjs/common` and `@nestjs/core` (the baseline) or the same plus `@nestrix-js/nestjs`, then
// reports the wall time and the CPU time (user + system, steadier on a busy machine) of those
// imports and the V8 heap after a forced GC. The cost is the
// difference of the medians. A third case adds `dist/runtime.js`, the module an enabled app loads
// with `import()` (and that the entry loaded statically before D-99), so the saving is measured in
// the same run, under the same machine load. Runs alternate between the cases so drift hits all
// alike. With `--modules` it also lists which OpenTelemetry packages the disabled import loaded.
//
//   node scripts/measure-import-cost.mjs [--runs 15] [--json] [--modules]
//
// Needs `pnpm build` first. A report, not a check: it never fails on the numbers.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "packages", "nestjs");
const requireFromPkg = createRequire(join(pkgDir, "package.json"));
const url = (spec) => pathToFileURL(requireFromPkg.resolve(spec)).href;

const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const runs = runsAt === -1 ? 15 : Number(args[runsAt + 1]);
const asJson = args.includes("--json");
const listModules = args.includes("--modules");

const baseline = [
  url("reflect-metadata"),
  url("@nestjs/common"),
  url("@nestjs/core"),
];
const nestrix = pathToFileURL(join(pkgDir, "dist", "index.js")).href;
const runtime = pathToFileURL(join(pkgDir, "dist", "runtime.js")).href;

function child(specs, withModules) {
  const hooks = withModules
    ? `const { registerHooks } = await import("node:module");
       const seen = new Set();
       registerHooks({ load(u, c, next) { seen.add(u); return next(u, c); } });`
    : "";
  const report = withModules
    ? `const otel = [...new Set([...seen].map((u) => /node_modules\\/(@opentelemetry\\/[^/]+)/.exec(u)?.[1]).filter(Boolean))].sort();
       out.otel = otel;`
    : "";
  return `${hooks}
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    for (const s of ${JSON.stringify(specs)}) await import(s);
    const ms = performance.now() - t0;
    const c = process.cpuUsage(c0);
    const cpu = (c.user + c.system) / 1000;
    globalThis.gc(); globalThis.gc();
    const out = { ms, cpu, heap: process.memoryUsage().heapUsed };
    ${report}
    process.stdout.write(JSON.stringify(out));`;
}

function run(specs, withModules = false) {
  const r = spawnSync(
    process.execPath,
    ["--expose-gc", "--input-type=module", "-e", child(specs, withModules)],
    {
      cwd: pkgDir,
      encoding: "utf8",
      env: { ...process.env, NESTRIX_ENABLED: "false" },
    },
  );
  if (r.status !== 0) {
    process.stderr.write(r.stderr);
    process.exit(1);
  }
  return JSON.parse(r.stdout);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// One discarded warm-up of each, so the first run does not pay for a cold file cache alone.
run(baseline);
run([...baseline, nestrix]);
run([...baseline, nestrix, runtime]);
const base = [];
const withNestrix = [];
const withRuntime = [];
for (let i = 0; i < runs; i++) {
  base.push(run(baseline));
  withNestrix.push(run([...baseline, nestrix]));
  withRuntime.push(run([...baseline, nestrix, runtime]));
}
const summary = (rs) => ({
  ms: median(rs.map((r) => r.ms)),
  cpuMs: median(rs.map((r) => r.cpu)),
  heapMB: median(rs.map((r) => r.heap)) / 2 ** 20,
});
const result = {
  node: process.version,
  runs,
  baseline: summary(base),
  withNestrix: summary(withNestrix),
  withRuntime: summary(withRuntime),
};
result.cost = {
  ms: result.withNestrix.ms - result.baseline.ms,
  cpuMs: result.withNestrix.cpuMs - result.baseline.cpuMs,
  heapMB: result.withNestrix.heapMB - result.baseline.heapMB,
};
result.costWithRuntime = {
  ms: result.withRuntime.ms - result.baseline.ms,
  cpuMs: result.withRuntime.cpuMs - result.baseline.cpuMs,
  heapMB: result.withRuntime.heapMB - result.baseline.heapMB,
};
if (listModules)
  result.otelPackagesLoaded = run([...baseline, nestrix], true).otel;

if (asJson) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const f = (n) => n.toFixed(1);
  console.log(
    `Import cost with NESTRIX_ENABLED=false (${runs} runs each, medians, ${result.node})`,
  );
  console.log(
    `  @nestjs/core alone:          ${f(result.baseline.ms)} ms wall, ${f(result.baseline.cpuMs)} ms CPU, ${f(result.baseline.heapMB)} MB heap`,
  );
  console.log(
    `  plus @nestrix-js/nestjs:     ${f(result.withNestrix.ms)} ms wall, ${f(result.withNestrix.cpuMs)} ms CPU, ${f(result.withNestrix.heapMB)} MB heap`,
  );
  console.log(
    `  cost of @nestrix-js/nestjs:  ${f(result.cost.ms)} ms wall, ${f(result.cost.cpuMs)} ms CPU, ${f(result.cost.heapMB)} MB heap`,
  );
  console.log(
    `  cost with the runtime too:   ${f(result.costWithRuntime.ms)} ms wall, ${f(result.costWithRuntime.cpuMs)} ms CPU, ${f(result.costWithRuntime.heapMB)} MB heap (an enabled app; the entry's cost before D-99)`,
  );
  if (result.otelPackagesLoaded) {
    console.log(
      `  OpenTelemetry packages loaded: ${result.otelPackagesLoaded.join(", ") || "none"}`,
    );
  }
}
