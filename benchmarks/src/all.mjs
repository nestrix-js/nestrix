// Runs every benchmark and writes results/ (one JSON and one Markdown file each, plus summary.md).
//   pnpm --filter benchmarks run all      full run: 10 s per route x 3 runs, 600 s outage
//   pnpm --filter benchmarks run smoke    short run of everything (a few minutes), results suffixed -smoke
// Flags: --skip=throughput,startup,install-size,outage   --duration, --runs, --outage-duration, ...
// (each is passed to the script that owns it; see the header of that script).
// Needs `pnpm build` first: the app loads the built packages.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInstallSize } from "./install-size.mjs";
import { parseArgs, resultsDir } from "./lib.mjs";
import { runOutage } from "./outage.mjs";
import { runStartup } from "./startup.mjs";
import { runThroughput } from "./throughput.mjs";

const args = parseArgs();
const smoke = Boolean(args.smoke);
const suffix = smoke ? "-smoke" : "";
const skip = new Set(
  String(args.skip ?? "")
    .split(",")
    .filter(Boolean),
);

const throughputArgs = {
  configs: "baseline,noexport,sink,unreachable,blackhole,upstream",
  ...(smoke ? { duration: 2, runs: 1, warmup: 1 } : {}),
  ...args,
  name: `throughput${suffix}`,
};
const startupArgs = {
  ...(smoke ? { repeats: 3 } : {}),
  ...args,
  configs: "baseline,noexport,sink",
  name: `startup${suffix}`,
};
const outageArgs = {
  ...(smoke ? { duration: 30, sample: 2, settle: 3 } : {}),
  ...args,
  ...(args["outage-duration"] ? { duration: args["outage-duration"] } : {}),
  name: `outage${suffix}`,
};
delete outageArgs.configs;

const names = [];
if (!skip.has("install-size")) {
  await runInstallSize({ name: `install-size${suffix}` });
  names.push(`install-size${suffix}`);
}
if (!skip.has("startup")) {
  await runStartup(startupArgs);
  names.push(`startup${suffix}`);
}
if (!skip.has("throughput")) {
  await runThroughput(throughputArgs);
  names.push(`throughput${suffix}`);
}
if (!skip.has("outage")) {
  await runOutage(outageArgs);
  names.push(`outage${suffix}`);
}

const order = [
  `throughput${suffix}`,
  `startup${suffix}`,
  `outage${suffix}`,
  `install-size${suffix}`,
];
// A skipped part is taken from its earlier result file, if there is one.
const parts = order
  .filter((n) => names.includes(n) || existsSync(join(resultsDir, `${n}.md`)))
  .map((n) => readFileSync(join(resultsDir, `${n}.md`), "utf8").trim());
writeFileSync(
  join(resultsDir, `summary${suffix}.md`),
  `${parts.join("\n\n")}\n`,
);
console.log(`wrote results/summary${suffix}.md`);
