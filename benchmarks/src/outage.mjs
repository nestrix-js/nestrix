// Exporter outage under sustained load (architecture section 4.9).
//
// Runs the same constant-rate load for `--duration` seconds (default 600) against:
//   control      the OTLP endpoint is a healthy local sink (the "reachable" run)
//   unreachable  the endpoint refuses connections
//   blackhole    the endpoint accepts the request and never answers
// sampling the app's RSS every `--sample` seconds (default 5). Before that, a calibration step
// measures the retained heap per queued span.
//
// Pass criterion (docs/backlog/phase-1.md, P1-13 "Outage pass criterion"). Every sample is taken
// after a forced GC (the app runs with --expose-gc), and everything is measured from minute 1
// (`--settle`, default 60 s; duration/10 for short runs) to the end of the run:
//   1. Heap plateau: median heap-after-GC <= the control's median + allowance, where
//        allowance = (maxQueueSize + 2 * maxExportBatchSize) * B_span + maxExportBatchSize * B_wire + 5 MB
//      B_span = 865 B (retained heap per queued span) and B_wire = 355 B (OTLP/JSON bytes per span),
//      measured once by this benchmark before HTTP spans existed; `--calibrate` re-measures both
//      (B_wire at the control sink) and uses the new values.
//   2. No heap trend: least-squares slope of heap-after-GC < 0.5 MB/min.
//   3. No RSS trend: least-squares slope of RSS <= the control's slope + 1 MB/min.
//   4. Connections: the most TCP connections the app has open at once, before shutdown starts, is <= 2.
//      Counted inside the app from Node's `net.client.socket` diagnostics channel (every client socket
//      created, until its `close`), so it also covers an endpoint that refuses connections; the
//      sink's own count of simultaneous accepted connections is reported next to it where there is one.
//   5. p99 latency over the whole run is within 5% of the control run's (the original P1-13 text).
// The old metric (peak RSS after the settle period minus RSS at it) is printed as informational only.
//
// `control` is the healthy local sink; `unreachable` refuses connections; `blackhole` accepts the
// request and never answers.
//
//   node src/outage.mjs [--duration=600] [--sample=5] [--settle=60] [--rate=3000]
//                       [--connections=64] [--variants=unreachable,blackhole] [--name=outage] [--calibrate]
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

const QUEUE_SIZE = 2048; // NestrixQueueOptions.maxQueueSize default
const BATCH_SIZE = 512; // NestrixQueueOptions.maxExportBatchSize default
const B_SPAN = 865; // bytes of retained heap per queued span, measured by `calibrate()`
const B_WIRE = 355; // OTLP/JSON bytes per span at the sink, measured before HTTP server spans existed
const MARGIN_MB = 5;
const MAX_CONNECTIONS = 2;
// A mix: two plain routes and the span-producing route twice.
const PATHS = ["/hello", "/users/42", "/spans", "/spans"];

/** Retained heap per span queued in a blackholed exporter: (heap(Q2) - heap(Q1)) / (Q2 - Q1). */
async function calibrate(repeats = 3) {
  const sizes = [2048, 20480];
  const heaps = {};
  const dropped = {};
  for (const size of sizes) {
    heaps[size] = [];
    for (let i = 0; i < repeats; i++) {
      const up = await bringUp("blackhole", {
        queueSize: size,
        execArgv: ["--expose-gc"],
      });
      // Enough /spans requests to overflow the larger queue several times over: 3 spans each.
      await load({
        port: up.app.port,
        paths: ["/spans"],
        duration: size === 2048 ? 2 : 6,
        connections: 64,
      });
      await sleep(500);
      await up.app.stats("gcstats");
      const s = await up.app.stats("gcstats");
      heaps[size].push(s.heapUsed);
      dropped[size] = s.counters?.droppedSpans;
      await up.finish();
    }
  }
  const [a, b] = sizes;
  const perSpan = (median(heaps[b]) - median(heaps[a])) / (b - a);
  return {
    sizes,
    heapUsedAfterGcBytes: Object.fromEntries(
      sizes.map((s) => [s, heaps[s].map((v) => Math.round(v))]),
    ),
    droppedSpans: dropped,
    heapBytesPerSpan: round(perSpan, 1),
  };
}

/**
 * Diagnostics on one series after the settle period (not part of the pass criteria): the
 * least-squares slope in MB per minute, and the mean of the last third minus the mean of the first.
 */
function trend(samples, settle, key) {
  const s = samples.filter((x) => x.t >= settle && typeof x[key] === "number");
  const n = s.length;
  if (n < 6) return undefined;
  const meanT = s.reduce((a, x) => a + x.t, 0) / n;
  const meanV = s.reduce((a, x) => a + x[key], 0) / n;
  let num = 0;
  let den = 0;
  for (const x of s) {
    num += (x.t - meanT) * (x[key] - meanV);
    den += (x.t - meanT) ** 2;
  }
  const k = Math.floor(n / 3);
  const mean = (a) => a.reduce((p, x) => p + x[key], 0) / a.length;
  return {
    slopeMbPerMin: round((num / den) * 60, 2),
    lastThirdMinusFirstThirdMb: round(
      mean(s.slice(-k)) - mean(s.slice(0, k)),
      1,
    ),
  };
}

/** Median of `key` over the samples at or after `settle` seconds. */
function medianAfter(samples, settle, key) {
  return median(samples.filter((x) => x.t >= settle).map((x) => x[key]));
}

async function runVariant(
  config,
  { duration, sample, settle, rate, connections },
) {
  const up = await bringUp(config, { execArgv: ["--expose-gc"] });
  const samples = [];
  const t0 = performance.now();
  let running = true;
  const loadPromise = load({
    port: up.app.port,
    paths: PATHS,
    duration,
    connections,
    rate,
  }).finally(() => {
    running = false;
  });
  const sampler = (async () => {
    while (running) {
      const [rssKb, stats] = await Promise.all([
        up.app.rssKb(),
        up.app.stats("gcstats"),
      ]);
      samples.push({
        t: round((performance.now() - t0) / 1000, 1),
        rssMb: round(rssKb / 1024, 1),
        // With --gc the heap is read after a forced collection: retained, not merely allocated.
        heapUsedMb: round(stats.heapUsed / 1048576, 1),
        externalMb: round(stats.external / 1048576, 1),
        dropped: stats.counters?.droppedSpans,
        exportFailed: stats.counters?.exportFailedSpans,
        exported: stats.counters?.exportedSpans,
      });
      await sleep(sample * 1000);
    }
  })();
  const result = await loadPromise;
  await sampler;
  const final = await up.app.stats();
  const end = await up.finish();

  const after = samples.filter((s) => s.t >= settle);
  const rssAtSettle = after[0]?.rssMb ?? Number.NaN;
  const peakAfter = Math.max(...after.map((s) => s.rssMb));
  return {
    config,
    result,
    counters: final.counters,
    clientConnections: final.connections,
    sinkReceived: end.sinkStats,
    rss: {
      settleSeconds: settle,
      atSettleMb: rssAtSettle,
      peakAfterSettleMb: peakAfter,
      finalMb: samples.at(-1)?.rssMb,
      peakGrowthMb: round(peakAfter - rssAtSettle, 1),
      finalGrowthMb: round(
        (samples.at(-1)?.rssMb ?? Number.NaN) - rssAtSettle,
        1,
      ),
      maxOverallMb: Math.max(...samples.map((s) => s.rssMb)),
    },
    trend: {
      rss: trend(samples, settle, "rssMb"),
      heapUsed: trend(samples, settle, "heapUsedMb"),
      external: trend(samples, settle, "externalMb"),
      heapAfterGc: true,
    },
    medians: {
      heapAfterGcMb: round(medianAfter(samples, settle, "heapUsedMb"), 2),
      rssMb: round(medianAfter(samples, settle, "rssMb"), 1),
    },
    samples,
  };
}

export async function runOutage(args) {
  const duration = numberOption(args, "duration", 600);
  const sample = numberOption(args, "sample", 5);
  const settle = numberOption(args, "settle", Math.min(60, duration / 10));
  const rate = numberOption(args, "rate", 3000);
  const connections = numberOption(args, "connections", 64);
  const variants = String(
    option(args, "variants", "unreachable,blackhole"),
  ).split(",");
  const name = String(option(args, "name", "outage"));
  const diagnose = Boolean(option(args, "diagnose", false));
  const settings = {
    duration,
    sample,
    settle,
    rate,
    connections,
    variants,
    paths: PATHS,
    maxQueueSize: QUEUE_SIZE,
    maxExportBatchSize: BATCH_SIZE,
  };

  if (diagnose) {
    // No calibration, control or verdict: sample the listed variants with a forced GC at every
    // sample, to tell retained heap from native memory and allocator slack.
    const runs = {};
    for (const config of variants) {
      console.log(`diagnose ${config}, ${duration} s`);
      runs[config] = await runVariant(config, settings);
    }
    const dmd = `# Outage diagnosis

${duration} s at ${rate} requests/s. Heap and external memory are read after a forced GC at every sample; trends are least-squares MB per minute after ${settle} s.

${mdTable(
  [
    "config",
    "RSS MB/min",
    "heap after GC MB/min",
    "external MB/min",
    "RSS last third - first third MB",
  ],
  Object.values(runs).map((r) => [
    r.config,
    r.trend.rss?.slopeMbPerMin,
    r.trend.heapUsed?.slopeMbPerMin,
    r.trend.external?.slopeMbPerMin,
    r.trend.rss?.lastThirdMinusFirstThirdMb,
  ]),
)}
`;
    const dout = { environment: environmentInfo(), settings, runs };
    writeResult(name, dout, dmd);
    return dout;
  }

  let bSpan = B_SPAN;
  let calibration;
  if (option(args, "calibrate", false)) {
    console.log("calibrating retained bytes per queued span");
    calibration = await calibrate();
    bSpan = calibration.heapBytesPerSpan;
    console.log(`  heapBytesPerSpan = ${bSpan}`);
  }

  console.log(`control (reachable sink), ${duration} s`);
  const control = await runVariant("sink", settings);
  const measuredWire =
    control.sinkReceived && control.sinkReceived.spans > 0
      ? round(control.sinkReceived.bytes / control.sinkReceived.spans, 1)
      : Number.NaN;

  // With --calibrate both constants are re-measured: spans now carry HTTP attributes, so the
  // wire size per span is the control's own.
  const bWire = calibration ? measuredWire : B_WIRE;
  const allowanceBytes =
    (QUEUE_SIZE + 2 * BATCH_SIZE) * bSpan + BATCH_SIZE * bWire;
  const allowanceMb = round(allowanceBytes / 1048576 + MARGIN_MB, 2);
  const controlHeapMedian = control.medians.heapAfterGcMb;
  const controlRssSlope = control.trend.rss?.slopeMbPerMin ?? Number.NaN;

  const outage = {};
  for (const config of variants) {
    console.log(`${config}, ${duration} s`);
    const run = await runVariant(config, settings);
    const p99 = run.result.latencyMs.p99;
    const controlP99 = control.result.latencyMs.p99;
    const heapSlope = run.trend.heapUsed?.slopeMbPerMin ?? Number.NaN;
    const rssSlope = run.trend.rss?.slopeMbPerMin ?? Number.NaN;
    const heapExcess = round(run.medians.heapAfterGcMb - controlHeapMedian, 2);
    const maxConn = run.clientConnections?.maxInFlight;
    const c = {
      heapPlateau: {
        excessMb: heapExcess,
        allowanceMb,
        pass: heapExcess <= allowanceMb,
      },
      heapSlope: { mbPerMin: heapSlope, limit: 0.5, pass: heapSlope < 0.5 },
      rssSlope: {
        mbPerMin: rssSlope,
        controlMbPerMin: controlRssSlope,
        limit: round(controlRssSlope + 1, 2),
        pass: rssSlope <= controlRssSlope + 1,
      },
      connections: {
        maxOpenClientSideBeforeShutdown: maxConn,
        created: run.clientConnections?.created,
        maxOpenAtSink: run.sinkReceived?.maxOpen,
        limit: MAX_CONNECTIONS,
        pass: typeof maxConn === "number" && maxConn <= MAX_CONNECTIONS,
      },
      p99: {
        ratioToControl: round(p99 / controlP99, 3),
        pass: p99 <= controlP99 * 1.05,
      },
    };
    c.pass = Object.values(c).every((x) => x.pass);
    run.criteria = c;
    outage[config] = run;
  }

  const allowance = {
    formula:
      "(maxQueueSize + 2 * maxExportBatchSize) * B_span + maxExportBatchSize * B_wire + 5 MB",
    maxQueueSize: QUEUE_SIZE,
    maxExportBatchSize: BATCH_SIZE,
    bSpan,
    bSpanSource: calibration
      ? "re-measured in this run"
      : "measured earlier (865 B)",
    bWire,
    measuredWireBytesPerSpanInControl: measuredWire,
    marginMb: MARGIN_MB,
    allowanceMb,
  };
  const out = {
    environment: environmentInfo(),
    settings,
    calibration,
    allowance,
    control,
    outage,
  };

  const mark = (x) => (x.pass ? "pass" : "FAIL");
  const row = (r) => [
    r.config,
    r.result.requestsPerSec,
    r.result.latencyMs.p50,
    r.result.latencyMs.p99,
    r.medians.heapAfterGcMb,
    r.trend.heapUsed?.slopeMbPerMin,
    r.medians.rssMb,
    r.trend.rss?.slopeMbPerMin,
    r.clientConnections?.maxInFlight,
    r.sinkReceived?.maxOpen ?? "n/a",
    `${r.counters?.exportedSpans ?? "?"} / ${r.counters?.exportFailedSpans ?? "?"} / ${r.counters?.droppedSpans ?? "?"}`,
  ];
  const info = (r) => [
    r.config,
    r.rss.atSettleMb,
    r.rss.peakAfterSettleMb,
    r.rss.peakGrowthMb,
    r.trend.rss?.lastThirdMinusFirstThirdMb,
  ];
  const verdict = Object.values(outage).map((r) => {
    const c = r.criteria;
    return `### ${r.config}: **${c.pass ? "PASS" : "FAIL"}**

1. Heap plateau: median heap-after-GC is ${c.heapPlateau.excessMb} MB above the control's ${controlHeapMedian} MB; allowance ${c.heapPlateau.allowanceMb} MB. ${mark(c.heapPlateau)}
2. Heap trend: slope ${c.heapSlope.mbPerMin} MB/min; limit < ${c.heapSlope.limit}. ${mark(c.heapSlope)}
3. RSS trend: slope ${c.rssSlope.mbPerMin} MB/min against the control's ${c.rssSlope.controlMbPerMin} + 1 = ${c.rssSlope.limit}. ${mark(c.rssSlope)}
4. Connections: at most ${c.connections.maxOpenClientSideBeforeShutdown} open at once before shutdown (${c.connections.created} created in total; the sink saw at most ${c.connections.maxOpenAtSink ?? "n/a"} at once); limit ${c.connections.limit}. ${mark(c.connections)}
5. p99 ${r.result.latencyMs.p99} ms is ${c.p99.ratioToControl}x the control's ${control.result.latencyMs.p99} ms; limit 1.05. ${mark(c.p99)}`;
  });
  const md = `# Exporter outage

${out.environment.platform}, Node ${out.environment.node}. ${duration} s of load at ${rate} requests/s (open rate, ${connections} connections) over ${PATHS.join(", ")}. Queue defaults: maxQueueSize ${QUEUE_SIZE}, maxExportBatchSize ${BATCH_SIZE}. The app runs with \`--expose-gc\` and a forced GC precedes every heap sample (every ${sample} s); medians and slopes use the samples from ${settle} s to the end.

${mdTable(
  [
    "config",
    "req/s",
    "p50 ms",
    "p99 ms",
    "median heap after GC MB",
    "heap slope MB/min",
    "median RSS MB",
    "RSS slope MB/min",
    "max client connections",
    "max connections at sink",
    "spans exported / failed / dropped",
  ],
  [row(control), ...Object.values(outage).map(row)],
)}

## Allowance

\`${allowance.formula}\` = ${allowanceMb} MB.

- B_span = ${bSpan} B retained heap per queued span (${allowance.bSpanSource}).
- B_wire = ${bWire} B of OTLP/JSON per span (${calibration ? "re-measured at this run's control sink" : `fixed; this run's control measured ${measuredWire} B`}).
- Client connections are counted inside the app from the \`net.client.socket\` diagnostics channel (created until \`close\`, idle keep-alive sockets included). For \`unreachable\` there is no server, so this is the only count; a refused attempt lives for well under a millisecond, so the sampling is exact (every socket is observed) but the maximum is of sockets alive at once, not of attempts per second.

## Verdict

${verdict.join("\n\n")}

## Informational: the old metric (not a criterion)

Peak RSS after ${settle} s minus RSS at ${settle} s. Allocator steps dominate it; the control has no outage and scores on it too.

${mdTable(
  [
    "config",
    `RSS at ${settle} s MB`,
    "RSS peak after MB",
    "growth MB",
    "last third - first third MB",
  ],
  [info(control), ...Object.values(outage).map(info)],
)}

Notes: latency is recorded per response at 10 us resolution; with a fixed request rate it is not corrected for coordinated omission. The forced GC every ${sample} s is the same in every run, so it does not bias the p99 comparison.
`;
  writeResult(name, out, md);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runOutage(parseArgs());
}
