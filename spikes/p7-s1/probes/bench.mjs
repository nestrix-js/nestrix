// Q3: overhead of a running capture. One fresh Express app per run, never two runs at once.
// For each route (trivial /hello, CPU-bound /cpu) and configuration (none; v8 at 1 ms; v8 at
// 10 ms; inspector Session at 1 ms): warm up, start the capture, load for DURATION seconds, stop,
// then load again for POST seconds with no capture (Q4: is anything slower after a stop?).
// Then the memory runs: a 30 s and a 120 s v8 capture at 1 ms under mixed load.
//
//   node probes/bench.mjs [--duration=20] [--warmup=5] [--post=10] [--connections=10]
//                         [--only=throughput|memory] [--memory=30,120]
//                         [--routes=/hello,/cpu] [--configs=none,v8 1ms,...] [--repeat=1]
// Takes about 7.5 minutes with the defaults. Prints one JSON line per run, then a summary table.
import { fileURLToPath } from "node:url";
import autocannon from "autocannon";
import { startApp } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const DURATION = Number(args.duration ?? 20);
const WARMUP = Number(args.warmup ?? 5);
const POST = Number(args.post ?? 10);
const CONNECTIONS = Number(args.connections ?? 10);
const appFile = fileURLToPath(new URL("../fixtures/app.mjs", import.meta.url));

const load = (url, duration, requests) =>
  new Promise((resolve, reject) => {
    autocannon(
      { url, connections: CONNECTIONS, duration, requests },
      (err, res) => (err ? reject(err) : resolve(res)),
    );
  });
const pick = (r) => ({
  rps: Math.round(r.requests.average),
  p50: r.latency.p50,
  p99: r.latency.p99,
  errors: r.errors + r.non2xx,
});

const configs = [
  { name: "none" },
  { name: "v8 1ms", api: "v8", intervalMs: 1 },
  { name: "v8 10ms", api: "v8", intervalMs: 10 },
  { name: "inspector 1ms", api: "inspector", intervalMs: 1 },
];
const rows = [];

if (!args.only || args.only === "throughput") {
  const routes = (args.routes ?? "/hello,/cpu").split(",");
  const chosen = args.configs
    ? configs.filter((c) => args.configs.split(",").includes(c.name))
    : configs;
  // --repeat interleaves the configurations (A B C A B C), so drift over time hits all of them.
  for (let rep = 0; rep < Number(args.repeat ?? 1); rep++)
    for (const route of routes) {
      for (const config of chosen) {
        const h = await startApp(appFile, { P7_ADAPTER: "express" }, [
          "--expose-gc",
        ]);
        try {
          const url = `${h.baseUrl}${route}`;
          await load(url, WARMUP);
          const start = config.api ? await h.call("start", config) : undefined;
          const during = pick(await load(url, DURATION));
          const stop = config.api ? await h.call("stop") : undefined;
          const post =
            config.api && POST > 0 ? pick(await load(url, POST)) : undefined;
          const row = {
            route,
            config: config.name,
            during,
            post,
            startMs: start?.startMs,
            startLoopDelayMs: start?.loopDelayMaxMs,
            codeBytes: start?.code?.code_and_metadata_size,
            stopMs: stop?.stopMs,
            parseMs: stop?.parseMs,
            samples: stop?.samples,
            profileBytes: stop?.jsonBytes,
            hotFound: stop?.hot.found,
            top1: stop?.top[0],
          };
          rows.push(row);
          console.log(JSON.stringify(row));
        } finally {
          h.kill();
        }
      }
    }
}

const memRows = [];
if (!args.only || args.only === "memory") {
  const runs = [{ seconds: 30, capture: false }];
  for (const seconds of (args.memory ?? "30,120").split(",").map(Number))
    runs.push({ seconds, capture: true });
  for (const { seconds, capture } of runs) {
    const h = await startApp(appFile, { P7_ADAPTER: "express" }, [
      "--expose-gc",
    ]);
    try {
      const requests = [{ path: "/hello" }, { path: "/cpu" }];
      await load(h.baseUrl, WARMUP, requests);
      const before = await h.call("memgc");
      const start = capture
        ? await h.call("start", { api: "v8", intervalMs: 1 })
        : undefined;
      const during = pick(await load(h.baseUrl, seconds, requests));
      const duringMem = await h.call("memgc");
      const stop = capture ? await h.call("stop") : undefined;
      const after = await h.call("memgc");
      const MB = (b) => Math.round((b / 1e6) * 10) / 10;
      const row = {
        seconds,
        capture,
        during,
        startMs: start?.startMs,
        samples: stop?.samples,
        nodes: stop?.nodes,
        profileMB: stop ? MB(stop.jsonBytes) : undefined,
        stopMs: stop?.stopMs,
        parseMs: stop?.parseMs,
        // Growth over the run, after a forced GC, with the capture still running.
        rssGrowthMB: MB(duringMem.rss - before.rss),
        heapGrowthMB: MB(duringMem.heapUsed - before.heapUsed),
        // While stop() holds the JSON string and the parsed object (no GC in between).
        heapWithStringMB: stop
          ? MB(stop.memory.afterStop.heapUsed - before.heapUsed)
          : undefined,
        heapWithParsedMB: stop
          ? MB(stop.memory.afterParse.heapUsed - before.heapUsed)
          : undefined,
        // After the profile is dropped and a forced GC.
        rssAfterMB: MB(after.rss - before.rss),
        heapAfterMB: MB(after.heapUsed - before.heapUsed),
      };
      memRows.push(row);
      console.log(JSON.stringify(row));
    } finally {
      h.kill();
    }
  }
}

if (rows.length) {
  console.log(
    "\n| Route | Config | req/s | p50 ms | p99 ms | req/s after stop | p99 after | start ms | stop ms | samples | profile KB |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(
      `| ${r.route} | ${r.config} | ${r.during.rps} | ${r.during.p50} | ${r.during.p99} | ${r.post?.rps ?? "-"} | ${r.post?.p99 ?? "-"} | ${r.startMs?.toFixed(1) ?? "-"} | ${r.stopMs?.toFixed(1) ?? "-"} | ${r.samples ?? "-"} | ${r.profileBytes ? Math.round(r.profileBytes / 1024) : "-"} |`,
    );
  }
}
