// Child process for Q2 (interference). The parent sends commands over IPC; each answers one
// message. "apm" stands for another in-process user of the inspector (an APM agent's Session).
import inspector from "node:inspector";
import { Session } from "node:inspector/promises";
import { createRequire } from "node:module";
import v8 from "node:v8";
import { esmHotLoop } from "./hot.mjs";
import { findFunction, medianDelta, validateProfile } from "./validate.mjs";

const require = createRequire(import.meta.url);
const { cjsHotLoop } = require("./hot.cjs");

function work(ms = 400) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    esmHotLoop(10);
    cjsHotLoop(10);
  }
}

function summary(profile) {
  return {
    problems: validateProfile(profile),
    samples: profile.samples.length,
    medianDeltaUs: medianDelta(profile),
    esm: findFunction(profile, "esmHotLoop").found,
    cjs: findFunction(profile, "cjsHotLoop").found,
  };
}

// Warm up outside any capture, so later captures attribute the hot functions (see Q1).
work(300);

let apm;
const handlers = {
  url: () => ({ url: inspector.url() ?? null }),
  work: ({ ms }) => {
    work(ms);
    return {};
  },
  async "apm-start"({ intervalUs = 10000 }) {
    apm = new Session();
    apm.connect();
    await apm.post("Profiler.enable");
    await apm.post("Profiler.setSamplingInterval", { interval: intervalUs });
    await apm.post("Profiler.start");
    return {};
  },
  async "apm-stop"() {
    const { profile } = await apm.post("Profiler.stop");
    apm.disconnect();
    return summary(profile);
  },
  "capture-v8": ({ intervalMs = 1, ms = 400 }) => {
    const handle = v8.startCpuProfile({ sampleInterval: intervalMs });
    work(ms);
    return summary(JSON.parse(handle.stop()));
  },
  async "capture-inspector"({ intervalMs = 1, ms = 400, disable = true }) {
    const s = new Session();
    s.connect();
    await s.post("Profiler.enable");
    let intervalError = null;
    try {
      await s.post("Profiler.setSamplingInterval", {
        interval: intervalMs * 1000,
      });
    } catch (e) {
      intervalError = String(e.message);
    }
    await s.post("Profiler.start");
    work(ms);
    const { profile } = await s.post("Profiler.stop");
    if (disable) await s.post("Profiler.disable");
    s.disconnect();
    return { ...summary(profile), intervalError };
  },
  // Two v8 handles at once: does the API refuse a second one?
  "v8-twice": () => {
    const a = v8.startCpuProfile({ sampleInterval: 1 });
    let b;
    let error = null;
    try {
      b = v8.startCpuProfile({ sampleInterval: 1 });
    } catch (e) {
      error = `${e.code}: ${e.message}`;
    }
    work(200);
    const second = b ? summary(JSON.parse(b.stop())) : null;
    const first = summary(JSON.parse(a.stop()));
    let stopAgain = null;
    try {
      a.stop();
    } catch (e) {
      stopAgain = `${e.code}: ${e.message}`;
    }
    return { error, first, second, stopAgain };
  },
};

process.on("message", async ({ id, cmd, args }) => {
  try {
    const result = await handlers[cmd](args ?? {});
    process.send({ id, ok: true, result });
  } catch (error) {
    process.send({ id, ok: false, error: String(error?.stack ?? error) });
  }
});
process.send({ ready: true });
