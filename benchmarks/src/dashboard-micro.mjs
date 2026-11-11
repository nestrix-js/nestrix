// Micro-costs behind the dashboard's per-request overhead (P2-12), in one process, no HTTP:
// RouteStatistics.record() per call, and the store processor per ended span (enqueue + drain,
// default limits, span from a real SDK 3 provider; the same provider without the processor is
// subtracted). Single-threaded, so these are CPU costs of the code, not of a loaded server.
//   node src/dashboard-micro.mjs [--name=dashboard-micro]
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  environmentInfo,
  mdTable,
  parseArgs,
  round,
  writeResult,
} from "./lib.mjs";

const nestjsEntry = fileURLToPath(import.meta.resolve("@nestrix/nestjs"));
const require = createRequire(nestjsEntry);
const dist = new URL("./", pathToFileURL(nestjsEntry)).href;
const { SpanKind } = require("@opentelemetry/api");
const { TracerProvider } = require("@opentelemetry/sdk-trace");
const { RouteStatistics } = await import(`${dist}stats/route-stats.js`);
const { createStoreProcessor } = await import(`${dist}store/processor.js`);
const { getOrCreateStore, DEFAULT_STORE_LIMITS } = await import(
  `${dist}store/index.js`
);

const args = parseArgs();
const timeIt = (n, fn) => {
  const t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn(i);
  return Number(process.hrtime.bigint() - t) / n; // ns per call
};

// RouteStatistics.record
const stats = new RouteStatistics();
const routes = ["/hello", "/users/:id", "/spans"];
const rec = (i) =>
  stats.record("GET", routes[i % 3], 1 + (i % 7), false, Date.now());
timeIt(300_000, rec);
const recordNs = [1, 2, 3].map(() => timeIt(3_000_000, rec));

// Store processor per span
const quiet = { logOnce() {}, countFailure() {} };
async function spanCost(withStore) {
  const store = withStore
    ? getOrCreateStore(DEFAULT_STORE_LIMITS, quiet)
    : undefined;
  store?.attach({});
  const provider = new TracerProvider({
    spanProcessors: withStore ? [createStoreProcessor(store)] : [],
  });
  const tracer = provider.getTracer("bench");
  const one = (i) => {
    const s = tracer.startSpan("GET /users/:id", {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": "GET",
        "url.path": `/users/${i}`,
        "http.route": "/users/:id",
        "http.response.status_code": 200,
        "server.address": "localhost",
        "client.address": "127.0.0.1",
      },
    });
    s.end();
    if (i % 256 === 0) store?.drainNow();
  };
  timeIt(100_000, one);
  const runs = [1, 2, 3].map(() => timeIt(500_000, one));
  store?.drainNow();
  return runs;
}
const without = await spanCost(false);
const withStore = await spanCost(true);
const med = (v) => [...v].sort((a, b) => a - b)[1];
const out = {
  recordNs: round(med(recordNs), 0),
  spanWithoutProcessorNs: round(med(without), 0),
  spanWithProcessorNs: round(med(withStore), 0),
  storeProcessorNsPerSpan: round(med(withStore) - med(without), 0),
  raw: { recordNs, without, withStore },
};
const md = `# Dashboard micro-costs

${environmentInfo().platform}, Node ${environmentInfo().node}. One process, no HTTP; median of 3 timed loops.

${mdTable(
  ["what", "ns per call"],
  [
    ["RouteStatistics.record() (3 keys)", out.recordNs],
    [
      "SDK span: start, 6 attributes, end, no processor",
      out.spanWithoutProcessorNs,
    ],
    [
      "same, with the store processor (enqueue + drain, default limits)",
      out.spanWithProcessorNs,
    ],
    ["store processor, per span (difference)", out.storeProcessorNsPerSpan],
  ],
)}
`;
writeResult(
  String(args.name ?? "dashboard-micro"),
  { environment: environmentInfo(), ...out },
  md,
);
