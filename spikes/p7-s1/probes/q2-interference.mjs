// Q2: does a capture disturb a host that already uses the inspector? Prints one JSON line per
// scenario.
//   A  a debugger attached over --inspect has Debugger and Profiler enabled and a profile running
//      (10 ms) while the app captures with v8.startCpuProfile, then with an inspector Session
//   B  the debugger pauses the main thread in the middle of a v8 capture, then resumes
//   C  another in-process Session (an APM agent) profiles at 10 ms while the app captures with
//      v8 at 1 ms, then with its own Session (which calls Profiler.disable at the end)
//   D  two v8.startCpuProfile handles at once; stop() twice
//   E  inspector.url() with and without --inspect (the only public signal that a debugger port is open)
import { fileURLToPath } from "node:url";
import {
  findFunction,
  medianDelta,
  validateProfile,
} from "../fixtures/validate.mjs";
import { cdp, inspectorUrl, startChild } from "./lib.mjs";

const childFile = fileURLToPath(
  new URL("../fixtures/q2-child.mjs", import.meta.url),
);
const sum = (profile) => ({
  problems: validateProfile(profile),
  samples: profile.samples.length,
  medianDeltaUs: medianDelta(profile),
  esm: findFunction(profile, "esmHotLoop").found,
  cjs: findFunction(profile, "cjsHotLoop").found,
});
const only = process.argv[2];
const log = (o) => console.log(JSON.stringify(o));

async function withChild(execArgv, fn) {
  const h = startChild(childFile, { execArgv });
  try {
    await h.ready;
    return await fn(h);
  } finally {
    h.kill();
  }
}

if (!only || only === "A") {
  await withChild(["--inspect=127.0.0.1:0"], async (h) => {
    const dt = await cdp(await inspectorUrl(h));
    await dt.send("Runtime.enable");
    await dt.send("Debugger.enable");
    await dt.send("Profiler.enable");
    await dt.send("Profiler.setSamplingInterval", { interval: 10000 });
    await dt.send("Profiler.start");
    const v8Capture = await h.call("capture-v8", { intervalMs: 1 });
    const sessionCapture = await h.call("capture-inspector", { intervalMs: 1 });
    await h.call("work", { ms: 200 });
    const { profile } = await dt.send("Profiler.stop");
    // Is the debugger still usable afterwards? Evaluate something and pause/resume once.
    const evaluated = await dt.send("Runtime.evaluate", { expression: "6*7" });
    dt.close();
    log({
      scenario: "A",
      v8Capture,
      sessionCapture,
      debuggerProfile: sum(profile),
      debuggerEvaluate: evaluated.result.value,
    });
  });
}

if (!only || only === "B") {
  await withChild(["--inspect=127.0.0.1:0"], async (h) => {
    const dt = await cdp(await inspectorUrl(h));
    await dt.send("Debugger.enable");
    const capture = h.call("capture-v8", { intervalMs: 1, ms: 600 });
    await new Promise((r) => setTimeout(r, 150));
    await dt.send("Debugger.pause");
    const paused = await dt.waitFor("Debugger.paused");
    const pausedAt = paused.params.callFrames[0]?.functionName;
    await new Promise((r) => setTimeout(r, 300));
    await dt.send("Debugger.resume");
    const result = await capture;
    dt.close();
    log({ scenario: "B", pausedAt, capture: result });
  });
}

if (!only || only === "C") {
  await withChild([], async (h) => {
    await h.call("apm-start", { intervalUs: 10000 });
    const v8Capture = await h.call("capture-v8", { intervalMs: 1 });
    const sessionCapture = await h.call("capture-inspector", {
      intervalMs: 1,
      disable: true,
    });
    await h.call("work", { ms: 300 });
    const apm = await h.call("apm-stop");
    log({ scenario: "C", v8Capture, sessionCapture, apm });
  });
}

if (!only || only === "D") {
  await withChild([], async (h) => {
    log({ scenario: "D", ...(await h.call("v8-twice")) });
  });
}

if (!only || only === "E") {
  const without = await withChild([], (h) => h.call("url"));
  const withInspect = await withChild(["--inspect=127.0.0.1:0"], (h) =>
    h.call("url"),
  );
  log({
    scenario: "E",
    without: without.url,
    withInspect: withInspect.url?.replace(/[0-9a-f-]{36}$/, "<uuid>"),
  });
}
