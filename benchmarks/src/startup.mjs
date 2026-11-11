// Startup time with and without NestrixModule: wall time from spawning the process to the first 200
// on GET /hello. Configurations are interleaved over the repetitions so drift hits all of them
// equally; one discarded round first warms the file cache.
//   node src/startup.mjs [--configs=baseline,noexport,sink] [--repeats=15] [--name=startup]
import {
  bringUp,
  CONFIGS,
  environmentInfo,
  mdTable,
  median,
  numberOption,
  option,
  parseArgs,
  round,
  writeResult,
} from "./lib.mjs";

export async function runStartup(args) {
  const configs = String(
    option(args, "configs", "baseline,noexport,sink"),
  ).split(",");
  const repeats = numberOption(args, "repeats", 15);
  const name = String(option(args, "name", "startup"));
  const samples = Object.fromEntries(configs.map((c) => [c, []]));

  for (let i = -1; i < repeats; i++) {
    for (const config of configs) {
      const up = await bringUp(config);
      if (i >= 0) samples[config].push(up.app.startupMs);
      await up.finish();
    }
    console.log(`startup round ${i + 1}/${repeats}`);
  }

  const stats = {};
  for (const config of configs) {
    const s = samples[config];
    stats[config] = {
      label: CONFIGS[config].label,
      medianMs: round(median(s), 1),
      minMs: round(Math.min(...s), 1),
      maxMs: round(Math.max(...s), 1),
      samplesMs: s.map((v) => round(v, 1)),
    };
  }
  const base = stats.baseline?.medianMs;
  const out = {
    environment: environmentInfo(),
    settings: { repeats, configs },
    stats,
  };
  const md = `# Startup time

${out.environment.platform}, Node ${out.environment.node}. Time from spawn to the first 200 on \`GET /hello\`, ${repeats} fresh processes per configuration (interleaved, after one discarded warm-up round). "Added" is the median minus the uninstrumented median. The exporting configurations point at a local sink and do not wait for it; export is asynchronous.

${mdTable(
  ["config", "median ms", "min ms", "max ms", "added vs baseline ms"],
  Object.entries(stats).map(([c, s]) => [
    c,
    s.medianMs,
    s.minMs,
    s.maxMs,
    base === undefined || c === "baseline" ? "" : round(s.medianMs - base, 1),
  ]),
)}
`;
  writeResult(name, out, md);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runStartup(parseArgs());
}
