// Q1: which public API captures a CPU profile of the main thread from inside the process?
// Runs each candidate around the same ESM and CommonJS hot functions and prints one JSON line
// per method: validity, where the hot functions were attributed, sample interval, wall time of
// start and stop on the main thread.
//
//   node probes/q1-apis.mjs [inspector|worker|v8|all] [sampleIntervalMs]

import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { createRequire } from "node:module";
import v8 from "node:v8";
import { Worker } from "node:worker_threads";
import { esmHotLoop } from "../fixtures/hot.mjs";
import {
  findFunction,
  medianDelta,
  topFunctions,
  validateProfile,
} from "../fixtures/validate.mjs";

const require = createRequire(import.meta.url);
const { cjsHotLoop } = require("../fixtures/hot.cjs");

const which = process.argv[2] ?? "all";
const intervalMs = Number(process.argv[3] ?? 1);
const out = process.env.P7_PROFILE_OUT;
// P7_WARMUP=1 runs the work before the capture, so the hot functions are already optimised (and
// inlined into their caller) when it starts, as in a host that has been serving for a while.
const warmup = process.env.P7_WARMUP === "1";

function work() {
  for (let i = 0; i < 10; i++) {
    esmHotLoop(20);
    cjsHotLoop(20);
  }
}

function report(method, profile, startMs, stopMs, extra = {}) {
  if (out)
    writeFileSync(`${out}.${method}.cpuprofile`, JSON.stringify(profile));
  console.log(
    JSON.stringify({
      method,
      problems: validateProfile(profile),
      samples: profile.samples.length,
      nodes: profile.nodes.length,
      medianDeltaUs: medianDelta(profile),
      esm: findFunction(profile, "esmHotLoop"),
      cjs: findFunction(profile, "cjsHotLoop"),
      top: topFunctions(profile, 4),
      startMs,
      stopMs,
      ...extra,
    }),
  );
}

async function viaInspector() {
  const session = new Session();
  session.connect();
  let t = performance.now();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", {
    interval: intervalMs * 1000,
  });
  await session.post("Profiler.start");
  const startMs = performance.now() - t;
  work();
  t = performance.now();
  const { profile } = await session.post("Profiler.stop");
  await session.post("Profiler.disable");
  const stopMs = performance.now() - t;
  session.disconnect();
  report("inspector", profile, startMs, stopMs);
}

async function viaWorker() {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const { Session } = require("node:inspector/promises");
    const session = new Session();
    session.connectToMainThread();
    parentPort.on("message", async (m) => {
      try {
        if (m === "start") {
          await session.post("Profiler.enable");
          await session.post("Profiler.setSamplingInterval", { interval: workerData * 1000 });
          await session.post("Profiler.start");
          parentPort.postMessage({ started: true });
        } else if (m === "stop") {
          const { profile } = await session.post("Profiler.stop");
          await session.post("Profiler.disable");
          session.disconnect();
          parentPort.postMessage({ profile });
        }
      } catch (e) { parentPort.postMessage({ error: String(e) }); }
    });
  `,
    { eval: true, workerData: intervalMs },
  );
  const next = () => new Promise((resolve) => worker.once("message", resolve));
  let t = performance.now();
  worker.postMessage("start");
  const started = await next();
  if (started.error) throw new Error(started.error);
  const startMs = performance.now() - t;
  work();
  t = performance.now();
  worker.postMessage("stop");
  const stopped = await next();
  const stopMs = performance.now() - t;
  await worker.terminate();
  if (stopped.error) throw new Error(stopped.error);
  report("worker", stopped.profile, startMs, stopMs);
}

function viaV8() {
  let t = performance.now();
  const handle = v8.startCpuProfile({ sampleInterval: intervalMs });
  const startMs = performance.now() - t;
  work();
  t = performance.now();
  const json = handle.stop();
  const parseT = performance.now();
  const profile = JSON.parse(json);
  const stopMs = parseT - t;
  report("v8", profile, startMs, stopMs, {
    jsonBytes: json.length,
    parseMs: performance.now() - parseT,
  });
}

if (warmup) for (let i = 0; i < 5; i++) work();

try {
  if (which === "inspector" || which === "all") await viaInspector();
  if (which === "worker" || which === "all") await viaWorker();
  if (which === "v8" || which === "all") viaV8();
} catch (error) {
  console.log(JSON.stringify({ error: String(error?.stack ?? error) }));
  process.exitCode = 1;
}
