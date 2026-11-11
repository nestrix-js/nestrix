// Q4: does a capture deoptimise code or change behaviour after it stops? Is Debugger.enable needed?
// Per variant, a fresh Nest app (Express) run with --allow-natives-syntax: warm the CPU route,
// read %GetOptimizationStatus(hotRouteWork), time 1,500 sequential requests (pre), capture while
// the same requests run, stop, read the status again, time 1,500 requests again (post). Also
// compares the profile with and without Debugger.enable.
//
//   node probes/q4-after.mjs [variants=v8,inspector,inspector+debugger]
import { fileURLToPath } from "node:url";
import { startApp } from "./lib.mjs";

const appFile = fileURLToPath(new URL("../fixtures/app.mjs", import.meta.url));
const variants = (process.argv[2] ?? "v8,inspector,inspector+debugger").split(
  ",",
);
const N = Number(process.env.P7_N ?? 1500);

for (const variant of variants) {
  const h = await startApp(appFile, { P7_ADAPTER: "express" }, [
    "--allow-natives-syntax",
  ]);
  try {
    const get = async (path) => {
      const res = await fetch(`${h.baseUrl}${path}`);
      return `${res.status} ${await res.text()}`;
    };
    const timed = async () => {
      const t = performance.now();
      const seen = new Set();
      for (let i = 0; i < N; i++) seen.add(await get("/cpu"));
      return { ms: performance.now() - t, distinct: seen.size };
    };
    const expected = await get("/cpu");
    for (let i = 0; i < 1000; i++) await get("/cpu");
    const optBefore = (await h.call("opt")).hotRouteWork;
    const pre = await timed();
    const api = variant.startsWith("inspector") ? "inspector" : "v8";
    await h.call("start", {
      api,
      intervalMs: 1,
      debuggerEnable: variant.endsWith("+debugger"),
    });
    const optStarted = (await h.call("opt")).hotRouteWork;
    const during = await timed();
    const stopped = await h.call("stop");
    const optAfter = (await h.call("opt")).hotRouteWork;
    const post = await timed();
    const optLater = (await h.call("opt")).hotRouteWork;
    const last = await get("/cpu");
    console.log(
      JSON.stringify({
        variant,
        opt: {
          before: optBefore,
          started: optStarted,
          afterStop: optAfter,
          afterPost: optLater,
        },
        msPer1500: {
          pre: Math.round(pre.ms),
          during: Math.round(during.ms),
          post: Math.round(post.ms),
        },
        responsesUnchanged:
          last === expected &&
          pre.distinct === 1 &&
          during.distinct === 1 &&
          post.distinct === 1,
        profile: {
          problems: stopped.problems,
          samples: stopped.samples,
          hotFound: stopped.hot.found,
          url: stopped.hot.url?.replace(/.*\/spikes\//, "spikes/"),
          line: stopped.hot.lineNumber,
          top: stopped.top.slice(0, 2),
        },
      }),
    );
  } finally {
    h.kill();
  }
}
