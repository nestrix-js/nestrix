// Latency, throughput, CPU and RSS per configuration and route. Each run is a fresh app process.
//   node src/throughput.mjs [--configs=baseline,sink,...] [--duration=10] [--runs=3]
//                           [--connections=64] [--warmup=2] [--name=throughput]
import {
  bringUp,
  CONFIGS,
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

const ROUTES = [
  { name: "GET /hello", path: "/hello" },
  { name: "GET /users/:id", path: "/users/42" },
];
// Only exists in Nestrix configurations; three spans per request. See app.mjs.
const SPANS_ROUTE = { name: "GET /spans (3 manual spans)", path: "/spans" };

export async function runThroughput(args) {
  const configs = String(
    option(args, "configs", "baseline,noexport,sink,unreachable,blackhole"),
  ).split(",");
  const duration = numberOption(args, "duration", 10);
  const runs = numberOption(args, "runs", 3);
  const connections = numberOption(args, "connections", 64);
  const warmup = numberOption(args, "warmup", 2);
  const name = String(
    option(
      args,
      "name",
      args.configs ? `throughput-${configs.join("-")}` : "throughput",
    ),
  );

  const out = {
    environment: environmentInfo(),
    settings: { duration, runs, connections, warmup, configs },
    configs: {},
  };

  for (const config of configs) {
    const spec = CONFIGS[config];
    if (!spec) throw new Error(`unknown configuration "${config}"`);
    const routes = spec.nestrix ? [...ROUTES, SPANS_ROUTE] : ROUTES;
    const perRun = [];
    for (let run = 1; run <= runs; run++) {
      console.log(`[${config}] run ${run}/${runs}`);
      let up;
      try {
        up = await bringUp(config);
      } catch (error) {
        out.configs[config] = {
          label: spec.label,
          error: String(error.message ?? error),
        };
        console.log(`[${config}] could not run: ${error.message}`);
        break;
      }
      const record = { startupMs: round(up.app.startupMs, 1), routes: {} };
      await load({
        port: up.app.port,
        paths: routes.map((r) => r.path),
        duration: warmup,
        connections,
      });
      for (const route of routes) {
        await sleep(300);
        const before = await up.app.stats();
        const result = await load({
          port: up.app.port,
          paths: [route.path],
          duration,
          connections,
        });
        const after = await up.app.stats();
        const cpuUs =
          after.cpuUserUs +
          after.cpuSystemUs -
          (before.cpuUserUs + before.cpuSystemUs);
        record.routes[route.name] = {
          ...result,
          cpuPercentOfOneCore: round(
            (cpuUs / 1000 / (result.seconds * 1000)) * 100,
            1,
          ),
          cpuMsPerRequest: round(
            cpuUs / 1000 / Math.max(1, result.requests),
            4,
          ),
          rssMb: round((await up.app.rssKb()) / 1024, 1),
          counters: after.counters,
          store: after.store,
        };
      }
      const end = await up.finish();
      record.sinkReceived = end.sinkStats;
      perRun.push(record);
    }
    if (perRun.length === 0) continue;
    const summary = {};
    for (const route of Object.keys(perRun[0].routes)) {
      const pick = (f) => median(perRun.map((r) => f(r.routes[route])));
      summary[route] = {
        p50Ms: round(
          pick((x) => x.latencyMs.p50),
          3,
        ),
        p99Ms: round(
          pick((x) => x.latencyMs.p99),
          3,
        ),
        requestsPerSec: round(
          pick((x) => x.requestsPerSec),
          0,
        ),
        cpuPercentOfOneCore: round(
          pick((x) => x.cpuPercentOfOneCore),
          1,
        ),
        rssMb: round(
          pick((x) => x.rssMb),
          1,
        ),
        errors: perRun.reduce(
          (n, r) => n + r.routes[route].errors + r.routes[route].non2xx,
          0,
        ),
      };
    }
    out.configs[config] = {
      label: spec.label,
      startupMs: round(median(perRun.map((r) => r.startupMs)), 1),
      summary,
      runs: perRun,
    };
  }

  const rows = [];
  const base = out.configs.baseline?.summary;
  for (const [config, entry] of Object.entries(out.configs)) {
    if (entry.error) {
      rows.push([
        config,
        "-",
        "-",
        "-",
        "-",
        "-",
        "-",
        "-",
        `not run: ${entry.error.split("\n")[0]}`,
      ]);
      continue;
    }
    for (const [route, s] of Object.entries(entry.summary)) {
      const delta = base?.[route]
        ? `${round(((s.requestsPerSec - base[route].requestsPerSec) / base[route].requestsPerSec) * 100, 1)}%`
        : "";
      rows.push([
        config,
        route,
        s.p50Ms,
        s.p99Ms,
        s.requestsPerSec,
        delta,
        s.cpuPercentOfOneCore,
        s.rssMb,
        s.errors,
      ]);
    }
  }
  const md = `# Throughput and latency

${out.environment.platform}, Node ${out.environment.node}, ${out.settings.runs} fresh-process run(s) per configuration, ${duration} s per route after ${warmup} s warmup, ${connections} connections (closed loop). Values are medians across runs. Load generator, app and sink are separate processes on one machine. Delta is throughput against the uninstrumented run of the same route.

${mdTable(["config", "route", "p50 ms", "p99 ms", "req/s", "vs baseline", "CPU % of one core", "RSS MB", "errors"], rows)}

Startup (spawn to first 200 on /hello, median): ${Object.entries(out.configs)
    .filter(([, e]) => !e.error)
    .map(([c, e]) => `${c} ${e.startupMs} ms`)
    .join(", ")}.
`;
  writeResult(name, out, md);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runThroughput(parseArgs());
}
