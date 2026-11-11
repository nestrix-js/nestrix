// Memory per configuration: process.memoryUsage() after a forced GC, idle after boot and again
// after load, plus RSS from `ps`. Each run is a fresh app process started with --expose-gc.
//   node src/memory.mjs [--configs=baseline,noexport,sink] [--runs=3] [--duration=10]
//                       [--connections=64] [--exec-argv="--max-semi-space-size=1"] [--name=memory]
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

const MB = 1024 * 1024;

export async function runMemory(args) {
  const configs = String(
    option(args, "configs", "baseline,noexport,sink"),
  ).split(",");
  const runs = numberOption(args, "runs", 3);
  const duration = numberOption(args, "duration", 10);
  const connections = numberOption(args, "connections", 64);
  const extra = String(option(args, "exec-argv", ""))
    .split(" ")
    .filter(Boolean);
  const name = String(option(args, "name", "memory"));
  const execArgv = [
    "--expose-gc",
    "--import",
    new URL("./module-count.mjs", import.meta.url).href,
    ...extra,
  ];

  const out = {
    environment: environmentInfo(),
    settings: { runs, duration, connections, execArgv, configs },
    configs: {},
  };

  const sample = async (app) => {
    const s = await app.stats("gcstats");
    return {
      rssMb: s.rss / MB,
      heapUsedMb: s.heapUsed / MB,
      heapTotalMb: (s.heapTotal ?? 0) / MB,
      externalMb: s.external / MB,
      arrayBuffersMb: s.arrayBuffers / MB,
      modules: s.modules,
      newSpaceMb: (s.spaces?.new_space?.size ?? 0) / MB,
      oldSpaceMb: (s.spaces?.old_space?.size ?? 0) / MB,
      codeSpaceMb: (s.spaces?.code_space?.size ?? 0) / MB,
      spaces: s.spaces,
    };
  };

  for (const config of configs) {
    const perRun = [];
    for (let run = 1; run <= runs; run++) {
      console.log(`[${config}] run ${run}/${runs}`);
      const up = await bringUp(config, { execArgv });
      await sleep(1000);
      const idle = await sample(up.app);
      const before = await up.app.stats();
      const result = await load({
        port: up.app.port,
        paths: ["/hello", "/users/42"],
        duration,
        connections,
      });
      const after = await up.app.stats();
      await sleep(1000);
      const loaded = await sample(up.app);
      // V8 bytes allocated per request during the load window (includes the IPC round trips).
      loaded.kbAllocatedPerRequest =
        (after.allocatedBytes - before.allocatedBytes) /
        1024 /
        Math.max(1, result.requests);
      idle.kbAllocatedPerRequest = 0;
      await up.finish();
      perRun.push({ idle, loaded });
    }
    const pick = (phase, key) =>
      round(median(perRun.map((r) => r[phase][key])), 1);
    const keys = [
      "rssMb",
      "heapUsedMb",
      "heapTotalMb",
      "externalMb",
      "arrayBuffersMb",
      "modules",
      "newSpaceMb",
      "oldSpaceMb",
      "codeSpaceMb",
      "kbAllocatedPerRequest",
    ];
    out.configs[config] = {
      idle: Object.fromEntries(keys.map((k) => [k, pick("idle", k)])),
      loaded: Object.fromEntries(keys.map((k) => [k, pick("loaded", k)])),
      runs: perRun,
    };
  }

  const rows = [];
  for (const [config, e] of Object.entries(out.configs)) {
    for (const phase of ["idle", "loaded"]) {
      const s = e[phase];
      rows.push([
        config,
        phase,
        s.rssMb,
        s.heapUsedMb,
        s.heapTotalMb,
        s.externalMb,
        s.arrayBuffersMb,
        s.modules,
        s.newSpaceMb,
        s.oldSpaceMb,
        s.codeSpaceMb,
        s.kbAllocatedPerRequest,
      ]);
    }
  }
  const md = `# Memory

${out.environment.platform}, Node ${out.environment.node}, ${runs} fresh-process run(s) per configuration, node ${execArgv.join(" ")}. Every value is \`process.memoryUsage()\` read inside the app right after \`gc()\`, median across runs. "idle" is 1 s after the first 200; "loaded" is 1 s after ${duration} s of load on /hello and /users/42 at ${connections} connections. "modules" counts ESM and CommonJS files loaded (\`module.registerHooks\` load hook).

${mdTable(["config", "phase", "RSS MB", "heap used MB", "heap total MB", "external MB", "arrayBuffers MB", "modules", "new space MB", "old space MB", "code space MB", "KB allocated per request"], rows)}
`;
  writeResult(name, out, md);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMemory(parseArgs());
}
