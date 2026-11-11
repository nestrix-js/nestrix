// Q1 in a Nest app: on each adapter and with each API, a capture taken while the CPU-bound route
// is called puts `hotRouteWork` at the top, with its file URL and line, and leaves responses
// unchanged. Also prints how long start and stop take on the main thread. One JSON line per run.
//
//   node probes/nest-capture.mjs [adapters=express,fastify,node] [apis=v8,inspector]
import { fileURLToPath } from "node:url";
import { startApp } from "./lib.mjs";

const appFile = fileURLToPath(new URL("../fixtures/app.mjs", import.meta.url));
const adapters = (process.argv[2] ?? "express,fastify,node").split(",");
const apis = (process.argv[3] ?? "v8,inspector").split(",");

for (const adapter of adapters) {
  for (const api of apis) {
    const h = await startApp(appFile, { P7_ADAPTER: adapter });
    try {
      const get = async (path) => {
        const res = await fetch(`${h.baseUrl}${path}`);
        return `${res.status} ${await res.text()}`;
      };
      const expected = await get("/cpu");
      for (let i = 0; i < Number(process.env.P7_WARM ?? 50); i++)
        await get("/cpu");
      const start = await h.call("start", { api, intervalMs: 1 });
      const during = new Set();
      for (let i = 0; i < 200; i++)
        during.add(await get(i % 2 ? "/cpu" : "/hello"));
      const r = await h.call("stop");
      const after = await get("/cpu");
      console.log(
        JSON.stringify({
          adapter,
          api,
          startMs: start.startMs,
          loopDelayMaxMs: start.loopDelayMaxMs,
          stopMs: r.stopMs,
          samples: r.samples,
          problems: r.problems,
          hot: r.hot,
          top: r.top.slice(0, 3),
          responsesUnchanged:
            during.size === 2 &&
            during.has(expected) &&
            during.has("200 hello") &&
            after === expected,
        }),
      );
    } finally {
      h.kill();
    }
  }
}
