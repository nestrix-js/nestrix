// Q5: AsyncLocalStorage and OpenTelemetry context keep working before, during and after a capture
// started and stopped from inside a Nest request handler (as the dashboard endpoint will), on
// each adapter, with each API. Q6 (feasibility): samples can be placed on the trace timeline by
// anchoring the profile's endTime to the moment stop() returned.
import "reflect-metadata";
import { AsyncLocalStorage } from "node:async_hooks";
import { Session } from "node:inspector/promises";
import { setTimeout as sleep } from "node:timers/promises";
import v8 from "node:v8";
import { Controller, Get, Module, Param, Post, Query } from "@nestjs/common";
import { type AdapterName, bootApp, type ReadableSpan } from "@nestrix/testing";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { afterAll, describe, expect, it } from "vitest";

const contextManager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(contextManager);
afterAll(() => {
  context.disable();
});

const als = new AsyncLocalStorage<string>();
const q6: (number | null)[] = [];
afterAll(() => {
  expect(
    q6.filter((x) => x !== null).length,
    JSON.stringify(q6),
  ).toBeGreaterThanOrEqual(3);
});
const tracer = trace.getTracer("p7-s1");

interface Profile {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
  }[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

function hotRouteWork(n: number): number {
  let x = 0;
  for (let i = 0; i < n; i++) x += Math.sqrt(i) * Math.sin(i);
  return x;
}

let current: { stop: () => Promise<string> } | undefined;
let lastProfile: { profile: Profile; stopEpochMs: number } | undefined;

@Controller()
class ProbeController {
  @Get("ctx/:id")
  async ctx(@Param("id") id: string) {
    return als.run(id, () =>
      tracer.startActiveSpan(`ctx-outer ${id}`, async (span) => {
        await sleep(1 + (Number(id) % 3));
        const inner = tracer.startSpan(`ctx-inner ${id}`);
        await sleep(1);
        inner.end();
        const ok = als.getStore() === id && trace.getActiveSpan() === span;
        span.end();
        return { id, ok };
      }),
    );
  }

  @Get("cpu")
  cpu() {
    return tracer.startActiveSpan("cpu-span", (span) => {
      const v = hotRouteWork(60000);
      span.end();
      return { v: v > 0 };
    });
  }

  @Post("capture/start")
  async start(@Query("api") api: string) {
    if (current) return { started: false };
    if (api === "inspector") {
      const session = new Session();
      session.connect();
      await session.post("Profiler.enable");
      await session.post("Profiler.start");
      current = {
        async stop() {
          const { profile } = await session.post("Profiler.stop");
          await session.post("Profiler.disable");
          session.disconnect();
          return JSON.stringify(profile);
        },
      };
    } else {
      const handle = v8.startCpuProfile({ sampleInterval: 1 });
      current = { stop: async () => handle.stop() };
    }
    return { started: true, ctx: als.getStore() ?? null };
  }

  @Post("capture/stop")
  async stop() {
    const c = current;
    current = undefined;
    if (!c) return { stopped: false };
    // The anchor is taken just before stop(): the profiler stops at the start of the call (the
    // v8 API) or of the synchronous dispatch (a same-thread Session); serialising and, for the
    // Session, resolving the promise come after and took up to 5 ms.
    const stopEpochMs = performance.timeOrigin + performance.now();
    const json = await c.stop();
    lastProfile = { profile: JSON.parse(json), stopEpochMs };
    return { stopped: true, bytes: json.length };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

const hrToMs = (t: [number, number]) => t[0] * 1e3 + t[1] / 1e6;

async function burst(baseUrl: string, from: number, n: number) {
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      fetch(`${baseUrl}/ctx/${from + i}`).then((r) => r.json()),
    ),
  );
  return results as { id: string; ok: boolean }[];
}

function checkParents(spans: ReadableSpan[], ids: number[]) {
  const bad: string[] = [];
  for (const id of ids) {
    const outer = spans.find((s) => s.name === `ctx-outer ${id}`);
    const inner = spans.find((s) => s.name === `ctx-inner ${id}`);
    if (!outer || !inner) bad.push(`${id}: missing`);
    else if (inner.parentSpanContext?.spanId !== outer.spanContext().spanId)
      bad.push(`${id}: wrong parent`);
  }
  return bad;
}

const adapters: AdapterName[] = ["express", "fastify", "node"];

describe.each(adapters)("Q5/Q6 on %s", (adapter) => {
  it.each(["v8", "inspector"])(
    "context and spans survive a capture (%s)",
    async (api) => {
      const booted = await bootApp(adapter, { module: ProbeModule });
      try {
        const { baseUrl } = booted;
        for (let i = 0; i < 300; i++)
          await fetch(`${baseUrl}/cpu`).then((r) => r.json());
        const before = await burst(baseUrl, 0, 20);
        const started = await fetch(`${baseUrl}/capture/start?api=${api}`, {
          method: "POST",
        }).then((r) => r.json());
        const during = await burst(baseUrl, 100, 20);
        for (let i = 0; i < 40; i++)
          await fetch(`${baseUrl}/cpu`).then((r) => r.json());
        const stopped = await fetch(`${baseUrl}/capture/stop`, {
          method: "POST",
        }).then((r) => r.json());
        const after = await burst(baseUrl, 200, 20);

        expect(started).toMatchObject({ started: true });
        expect(stopped).toMatchObject({ stopped: true });
        for (const r of [...before, ...during, ...after])
          expect(r.ok, `ctx ${r.id}`).toBe(true);
        const spans = booted.spans();
        const ids = [...before, ...during, ...after].map((r) => Number(r.id));
        expect(checkParents(spans, ids)).toEqual([]);

        // Q6: place each sample on the epoch timeline, anchored at stop, and count the samples in
        // the CPU route that fall inside a cpu-span. Requests are sequential here, so a window
        // contains one request; with concurrency it would contain several (only time-window
        // attribution is possible on one thread).
        const { profile, stopEpochMs } = lastProfile as {
          profile: Profile;
          stopEpochMs: number;
        };
        // `cpu` too: in this shared process hotRouteWork is sometimes optimised during an earlier
        // capture, and is then attributed to `cpu`, the caller it is inlined into (see Q1).
        const hotIds = new Set(
          profile.nodes
            .filter(
              (n) =>
                n.callFrame.functionName === "hotRouteWork" ||
                n.callFrame.functionName === "cpu",
            )
            .map((n) => n.id),
        );
        const windows = spans
          .filter((s) => s.name === "cpu-span")
          .map((s) => [hrToMs(s.startTime), hrToMs(s.endTime)] as const)
          .filter(
            ([, end]) =>
              end >= stopEpochMs - (profile.endTime - profile.startTime) / 1000,
          );
        let t = profile.startTime;
        let hot = 0;
        let inside = 0;
        for (let i = 0; i < profile.samples.length; i++) {
          t += profile.timeDeltas[i];
          if (!hotIds.has(profile.samples[i])) continue;
          hot++;
          const epoch = stopEpochMs - (profile.endTime - t) / 1000;
          // 2 ms slack for the anchor (the time stop() itself takes).
          if (windows.some(([s, e]) => epoch >= s - 2 && epoch <= e + 2))
            inside++;
        }
        console.log(
          JSON.stringify({
            adapter,
            api,
            hotSamples: hot,
            insideCpuSpans: inside,
            share: inside / Math.max(hot, 1),
          }),
        );
        // In this shared process the CPU route is sometimes optimised after an earlier capture and
        // then folded into a framework caller (`run`, the context manager's), so a run can have no
        // attributable samples (Q1). Q6 is checked on the runs that have them; afterAll requires half.
        q6.push(hot === 0 ? null : inside / hot);
        if (hot > 0) expect(inside / hot).toBeGreaterThan(0.9);
      } finally {
        await booted.close();
      }
    },
  );
});
