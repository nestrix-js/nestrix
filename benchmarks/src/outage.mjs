// Exporter outage under sustained load (architecture section 4.9).
//
// Runs the same constant-rate load for `--duration` seconds (default 600) against:
//   control      the OTLP endpoint is a healthy local sink (the "reachable" run)
//   unreachable  the endpoint refuses connections
//   blackhole    the endpoint accepts the request and never answers
// sampling the app's RSS every `--sample` seconds (default 5). Before that, a calibration step
// measures the retained heap per queued span.
//
// Pass criteria (both must hold for each outage variant):
//   1. RSS growth after the settle period (default 60 s; duration/10 for short runs) is within
//        bound = (maxQueueSize + maxExportBatchSize) * heapBytesPerSpan
//                + maxExportBatchSize * wireBytesPerSpan
//                + rssNoiseMb
//      heapBytesPerSpan: marginal retained heap per queued span, measured here by filling a blackholed
//      queue of two sizes and comparing heap after GC. wireBytesPerSpan: bytes per span of the
//      OTLP/JSON body, measured at the control run's sink. rssNoiseMb: RSS growth after the settle
//      period in the control run, which has no outage (allocator and GC noise, not queue).
//   2. p99 latency over the whole run is within 5% of the control run's p99.
//
//   node src/outage.mjs [--duration=600] [--sample=5] [--settle=60] [--rate=3000]
//                       [--connections=64] [--variants=unreachable,blackhole] [--name=outage]
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

async function runVariant(
  config,
  { duration, sample, settle, rate, connections, gc },
) {
  const up = await bringUp(
    config,
    gc ? { execArgv: ["--expose-gc"] } : undefined,
  );
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
        up.app.stats(gc ? "gcstats" : "stats"),
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
      heapAfterGc: Boolean(gc),
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
  const gc = Boolean(option(args, "gc", false));
  const diagnose = Boolean(option(args, "diagnose", false));
  const settings = {
    gc,
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
      runs[config] = await runVariant(config, { ...settings, gc: true });
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

  console.log("calibrating retained bytes per queued span");
  const calibration = await calibrate();
  console.log(`  heapBytesPerSpan = ${calibration.heapBytesPerSpan}`);

  console.log(`control (reachable sink), ${duration} s`);
  const control = await runVariant("sink", settings);
  const wireBytesPerSpan =
    control.sinkReceived && control.sinkReceived.spans > 0
      ? round(control.sinkReceived.bytes / control.sinkReceived.spans, 1)
      : Number.NaN;
  const rssNoiseMb = Math.max(0, control.rss.peakGrowthMb);

  const boundBytes =
    (QUEUE_SIZE + BATCH_SIZE) * calibration.heapBytesPerSpan +
    BATCH_SIZE * wireBytesPerSpan;
  const boundMb = round(boundBytes / 1048576 + rssNoiseMb, 1);

  const outage = {};
  for (const config of variants) {
    console.log(`${config}, ${duration} s`);
    const run = await runVariant(config, settings);
    const p99 = run.result.latencyMs.p99;
    const controlP99 = control.result.latencyMs.p99;
    run.criteria = {
      rssGrowthWithinBound: run.rss.peakGrowthMb <= boundMb,
      p99WithinFivePercent: p99 <= controlP99 * 1.05,
      p99RatioToControl: round(p99 / controlP99, 3),
    };
    run.criteria.pass =
      run.criteria.rssGrowthWithinBound && run.criteria.p99WithinFivePercent;
    outage[config] = run;
  }

  const bound = {
    formula:
      "(maxQueueSize + maxExportBatchSize) * heapBytesPerSpan + maxExportBatchSize * wireBytesPerSpan + rssNoiseMb",
    maxQueueSize: QUEUE_SIZE,
    maxExportBatchSize: BATCH_SIZE,
    heapBytesPerSpan: calibration.heapBytesPerSpan,
    wireBytesPerSpan,
    rssNoiseMb,
    boundMb,
  };
  const out = {
    environment: environmentInfo(),
    settings,
    calibration,
    bound,
    control,
    outage,
  };

  const row = (r) => [
    r.config,
    r.result.requestsPerSec,
    r.result.latencyMs.p50,
    r.result.latencyMs.p99,
    r.rss.atSettleMb,
    r.rss.peakAfterSettleMb,
    r.rss.peakGrowthMb,
    r.trend.rss?.slopeMbPerMin,
    r.trend.rss?.lastThirdMinusFirstThirdMb,
    `${r.counters?.exportedSpans ?? "?"} / ${r.counters?.exportFailedSpans ?? "?"} / ${r.counters?.droppedSpans ?? "?"}`,
  ];
  const verdict = Object.values(outage).map(
    (r) =>
      `- ${r.config}: RSS growth ${r.rss.peakGrowthMb} MB against a bound of ${boundMb} MB (${r.criteria.rssGrowthWithinBound ? "within" : "EXCEEDED"}); p99 ${r.result.latencyMs.p99} ms is ${r.criteria.p99RatioToControl}x the control's ${control.result.latencyMs.p99} ms (${r.criteria.p99WithinFivePercent ? "within 5%" : "OUTSIDE 5%"}). **${r.criteria.pass ? "PASS" : "FAIL"}**`,
  );
  const md = `# Exporter outage

${out.environment.platform}, Node ${out.environment.node}. ${duration} s of load at ${rate} requests/s (open rate, ${connections} connections) over ${PATHS.join(", ")}; RSS sampled every ${sample} s; growth is measured from the first sample at or after ${settle} s to the peak after it. Queue defaults: maxQueueSize ${QUEUE_SIZE}, maxExportBatchSize ${BATCH_SIZE}.

${mdTable(
  [
    "config",
    "req/s",
    "p50 ms",
    "p99 ms",
    `RSS at ${settle} s MB`,
    "RSS peak after MB",
    "growth MB",
    "trend MB/min (diagnostic)",
    "last third - first third MB (diagnostic)",
    "spans exported / failed / dropped",
  ],
  [row(control), ...Object.values(outage).map(row)],
)}

## RSS bound

\`${bound.formula}\`

- heapBytesPerSpan = ${bound.heapBytesPerSpan} B, the marginal retained heap per queued span (heap after GC with a blackholed queue of ${calibration.sizes[0]} against ${calibration.sizes[1]} spans, median of 3 runs each; both queues overflowed: dropped ${JSON.stringify(calibration.droppedSpans)}).
- wireBytesPerSpan = ${bound.wireBytesPerSpan} B, from the control run's sink (OTLP/JSON bytes received per span).
- rssNoiseMb = ${bound.rssNoiseMb} MB, the control run's own RSS growth after ${settle} s, with no outage.
- bound = ${boundMb} MB.

## Verdict

${verdict.join("\n")}

Notes: latency is recorded per response at 10 us resolution; with a fixed request rate it is not corrected for coordinated omission. Until HTTP server spans exist (P1-06) the only spans are the three \`withSpan\` spans of \`/spans\`.
`;
  writeResult(name, out, md);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runOutage(parseArgs());
}
