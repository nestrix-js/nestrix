// What the dashboard holds in memory (P2-12): idle RSS after startup, then RSS and heap after a
// forced GC following a short load, headless against dashboard, one fresh process each, so the
// RSS difference seen under load can be split into live heap and allocator/young-generation slack.
//   node src/dashboard-memory.mjs [--duration=5] [--configs=headless,dashboard] [--name=dashboard-memory]
import {
  bringUp,
  environmentInfo,
  load,
  mdTable,
  numberOption,
  option,
  parseArgs,
  round,
  sleep,
  writeResult,
} from "./lib.mjs";

const args = parseArgs();
const duration = numberOption(args, "duration", 5);
const configs = String(option(args, "configs", "headless,dashboard")).split(
  ",",
);
const name = String(option(args, "name", "dashboard-memory"));
const mb = (n) => round(n / 1048576, 1);
const rows = {};
for (const config of configs) {
  const up = await bringUp(config, { execArgv: ["--expose-gc"] });
  await sleep(500);
  const idleRssMb = round((await up.app.rssKb()) / 1024, 1);
  const idle = await up.app.stats("gcstats");
  await load({
    port: up.app.port,
    paths: ["/users/42"],
    duration,
    connections: 64,
  });
  await sleep(300);
  const rssLoadedMb = round((await up.app.rssKb()) / 1024, 1);
  const after = await up.app.stats("gcstats");
  await sleep(300);
  const rssAfterGcMb = round((await up.app.rssKb()) / 1024, 1);
  rows[config] = {
    idleRssMb,
    idleHeapMb: mb(idle.heapUsed),
    rssAfterLoadMb: rssLoadedMb,
    rssAfterLoadAndGcMb: rssAfterGcMb,
    heapAfterLoadGcMb: mb(after.heapUsed),
    heapTotalAfterLoadGcMb: mb(after.heapTotal),
    externalMb: mb(after.external),
    storeTraces: after.store?.traces,
    storeEstimateMb: after.store ? mb(after.store.bytes) : undefined,
  };
  await up.finish();
  console.log(`${config} done`);
}
const md = `# Dashboard memory

${environmentInfo().platform}, Node ${environmentInfo().node}. One fresh process per configuration (\`--expose-gc\`); ${duration} s of load on GET /users/42 at 64 connections, then a forced GC. The store is at its default limits.

${mdTable(
  [
    "config",
    "idle RSS MB",
    "idle heap MB",
    "RSS after load MB",
    "RSS after load + GC MB",
    "heap after load + GC MB",
    "heap total MB",
    "external MB",
    "store traces",
    "store estimate MB",
  ],
  Object.entries(rows).map(([c, r]) => [
    c,
    r.idleRssMb,
    r.idleHeapMb,
    r.rssAfterLoadMb,
    r.rssAfterLoadAndGcMb,
    r.heapAfterLoadGcMb,
    r.heapTotalAfterLoadGcMb,
    r.externalMb,
    r.storeTraces ?? "",
    r.storeEstimateMb ?? "",
  ]),
)}
`;
writeResult(
  name,
  { environment: environmentInfo(), settings: { duration }, rows },
  md,
);
