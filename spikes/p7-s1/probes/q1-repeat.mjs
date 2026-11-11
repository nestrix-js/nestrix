// Q1 follow-up: do repeated captures in one process keep attributing the hot functions?
// Found while running q1-apis.mjs: after a first capture, a second one (with another API) put
// all samples in `work`, the caller the hot functions are inlined into.
//
//   node probes/q1-repeat.mjs <sequence>   e.g. "v8,v8,v8" or "inspector,v8" or "v8empty,warm,v8"
// Steps: v8 | inspector (a capture around the work), warm (the work, no capture), v8empty (a
// capture with no work in it), inspempty (the same through a Session),
// heapempty (a sampling heap profile with no work in it).
import { Session } from "node:inspector/promises";
import { createRequire } from "node:module";
import v8 from "node:v8";
import { esmHotLoop } from "../fixtures/hot.mjs";
import {
  findFunction,
  topFunctions,
  validateProfile,
} from "../fixtures/validate.mjs";

const require = createRequire(import.meta.url);
const { cjsHotLoop } = require("../fixtures/hot.cjs");
const sequence = (process.argv[2] ?? "v8,v8,v8").split(",");
const sessionPerCapture = process.env.P7_SESSION_PER_CAPTURE !== "0";

function work() {
  for (let i = 0; i < 10; i++) {
    esmHotLoop(20);
    cjsHotLoop(20);
  }
}

let shared;
async function inspectorCapture() {
  let session;
  if (sessionPerCapture) {
    session = new Session();
    session.connect();
  } else if (shared) {
    session = shared;
  } else {
    session = shared = new Session();
    session.connect();
  }
  await session.post("Profiler.enable");
  await session.post("Profiler.start");
  work();
  const { profile } = await session.post("Profiler.stop");
  await session.post("Profiler.disable");
  if (sessionPerCapture) session.disconnect();
  return profile;
}

function v8Capture() {
  const handle = v8.startCpuProfile({ sampleInterval: 1 });
  work();
  return JSON.parse(handle.stop());
}

if (process.env.P7_WARMUP === "1") for (let i = 0; i < 5; i++) work();
for (const [i, method] of sequence.entries()) {
  // "warm": run the work with no capture. "v8empty": a capture with no work in it.
  if (method === "warm") {
    for (let j = 0; j < 5; j++) work();
    continue;
  }
  if (method === "v8empty") {
    v8.startCpuProfile({ sampleInterval: 1 }).stop();
    continue;
  }
  if (method === "inspempty") {
    const s = new Session();
    s.connect();
    await s.post("Profiler.enable");
    await s.post("Profiler.start");
    await s.post("Profiler.stop");
    await s.post("Profiler.disable");
    s.disconnect();
    continue;
  }
  if (method === "heapempty") {
    v8.startHeapProfile().stop();
    continue;
  }
  const profile = method === "v8" ? v8Capture() : await inspectorCapture();
  const esm = findFunction(profile, "esmHotLoop");
  const cjs = findFunction(profile, "cjsHotLoop");
  console.log(
    JSON.stringify({
      i,
      method,
      problems: validateProfile(profile),
      esm: esm.found,
      esmShare: Number(esm.selfShare.toFixed(2)),
      cjs: cjs.found,
      cjsShare: Number(cjs.selfShare.toFixed(2)),
      top: topFunctions(profile, 1).map((s) =>
        s.replace(/(file:\/\/)?\/.*\/p7-s1\//, ""),
      ),
    }),
  );
}
