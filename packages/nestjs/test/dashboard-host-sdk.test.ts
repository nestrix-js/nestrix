// Global state: the host registered its own SDK 3 provider before Nestrix, with
// nestrixSpanProcessor() beside its exporter. With the dashboard on, `meta` says the host owns
// sampling (`rate: null`) and carries the nestrixSpanProcessor() hint until the first span
// reaches the store; then the hint goes and the host's traffic is listed.
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterEach, describe, expect, it } from "vitest";
import { nestrixSpanProcessor } from "../src/store/span-processor.js";
import {
  ADAPTERS,
  BEARER,
  bootDashboardApp,
  type DashboardApp,
  get,
  TOKEN,
} from "./dashboard-fixture.js";

trace.setGlobalTracerProvider(
  new TracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor({ exporter: new InMemorySpanExporter() }),
      nestrixSpanProcessor(),
    ],
  }),
);
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

let booted: DashboardApp | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

interface Meta {
  sampling: { owner: string; rate: number | null };
  warnings: { code: string; message: string }[];
}

describe.each(ADAPTERS)("host-owned SDK on %s", (adapter) => {
  it("meta: host sampling, and the processor hint only until a span arrives", async () => {
    booted = await bootDashboardApp({
      adapter,
      nestrix: { ui: { enabled: true, auth: { token: TOKEN } } },
    });
    const api = `${booted.baseUrl}/_nestrix/api/v1`;
    const before = (await get(`${api}/meta`, BEARER)).json() as Meta;
    expect(before.sampling).toEqual({ owner: "host", rate: null });
    // Only in the first test: the store is per process and later tests have spans already.
    if (adapter === "express") {
      expect(before.warnings.map((w) => w.code)).toEqual([
        "host-span-processor",
      ]);
      expect(before.warnings[0]?.message).toContain("nestrixSpanProcessor()");
    }

    await get(`${booted.baseUrl}/h/ok`);
    let after = (await get(`${api}/meta`, BEARER)).json() as Meta;
    for (let i = 0; i < 50 && after.warnings.length > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      after = (await get(`${api}/meta`, BEARER)).json() as Meta;
    }
    expect(after.warnings).toEqual([]);
    const list = (await get(`${api}/traces`, BEARER)).json() as {
      items: { route?: string }[];
    };
    expect(list.items.map((i) => i.route)).toContain("/h/ok");
  });
});
