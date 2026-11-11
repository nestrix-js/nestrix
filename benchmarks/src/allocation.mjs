// Per-request allocation (P2-15): V8 bytes allocated per request and scavenges per 10,000
// requests, per configuration, from inside the app process (total_allocated_bytes and a gc
// PerformanceObserver; see app.mjs). Each run is a fresh process; the baseline (uninstrumented)
// is subtracted to give Nestrix's own share.
//   node src/allocation.mjs [--configs=baseline,headless,dashboard] [--runs=3] [--duration=8]
//                           [--name=allocation]
import {
  bringUp,
  environmentInfo,
  load,
  mdTable,
  median,
  numberOption,
  option,
  parseArgs,
  round,
  sleep,
  writeResult,
} from "./lib.mjs";

process.env.BENCH_GC_COUNT = "1"; // inherited by the app process
const args = parseArgs();
const configs = String(
  option(args, "configs", "baseline,headless,dashboard"),
).split(",");
const runs = numberOption(args, "runs", 3);
const duration = numberOption(args, "duration", 8);
const name = String(option(args, "name", "allocation"));

const out = {
  environment: environmentInfo(),
  settings: { configs, runs, duration },
  configs: {},
};
for (const config of configs) {
  const per = [];
  for (let run = 1; run <= runs; run++) {
    const up = await bringUp(config, { execArgv: ["--expose-gc"] });
    // Warm up so JIT and caches are out of the window.
    await load({
      port: up.app.port,
      paths: ["/hello", "/users/42"],
      duration: 2,
    });
    await sleep(300);
    const before = await up.app.stats();
    const result = await load({
      port: up.app.port,
      paths: ["/hello", "/users/42"],
      duration,
    });
    const after = await up.app.stats();
    await up.finish();
    const n = result.requests;
    per.push({
      requests: n,
      reqPerSec: n / duration,
      bytesPerRequest: (after.allocatedBytes - before.allocatedBytes) / n,
      scavengesPer10k:
        ((after.gc.scavenges - before.gc.scavenges) / n) * 10_000,
      majorPer10k: ((after.gc.major - before.gc.major) / n) * 10_000,
    });
    console.log(`[${config}] run ${run}/${runs}`, per.at(-1));
  }
  const pick = (k, d = 1) => round(median(per.map((r) => r[k])), d);
  out.configs[config] = {
    bytesPerRequest: pick("bytesPerRequest", 0),
    scavengesPer10k: pick("scavengesPer10k", 2),
    majorPer10k: pick("majorPer10k", 2),
    reqPerSec: pick("reqPerSec", 0),
    runs: per,
  };
}
const base = out.configs.baseline?.bytesPerRequest;
const md = `# Allocation per request (${name})

${environmentInfo().platform}, Node ${environmentInfo().node}. ${runs} fresh-process runs per config, ${duration} s after a 2 s warmup, 64 connections, /hello and /users/42 alternating. Medians. Bytes are V8 \`total_allocated_bytes\` deltas in the app process per completed request (includes Node http and Nest); scavenges are gc PerformanceObserver minor entries.

${mdTable(
  [
    "config",
    "B/request",
    "Nestrix share B/request",
    "scavenges / 10k req",
    "req/s",
  ],
  Object.entries(out.configs).map(([c, e]) => [
    c,
    e.bytesPerRequest,
    base === undefined || c === "baseline" ? "" : e.bytesPerRequest - base,
    e.scavengesPer10k,
    e.reqPerSec,
  ]),
)}
`;
writeResult(name, out, md);
