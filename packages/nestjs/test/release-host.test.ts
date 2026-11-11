// Global state: the host registered its own SDK 3 provider, with a resource carrying its own
// `service.version`, and nestrixSpanProcessor(), before Nestrix. P3-03 / D-63: Nestrix's
// `serviceVersion` is not applied to a host-owned resource; each trace's `release` is the host's
// version, and `meta` leaves the version out (it cannot read the host's resource).
import { Controller, Get } from "@nestjs/common";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { afterAll, describe, expect, it } from "vitest";
import { nestrixSpanProcessor } from "../src/store/span-processor.js";
import {
  BEARER,
  bootDashboardApp,
  type DashboardApp,
  get,
  TOKEN,
} from "./dashboard-fixture.js";

trace.setGlobalTracerProvider(
  new TracerProvider({
    resource: resourceFromAttributes({
      "service.name": "host-svc",
      "service.version": "host-1",
    }),
    spanProcessors: [nestrixSpanProcessor()],
  }),
);
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

@Controller("h")
class HostVersionController {
  @Get("v")
  v(): string {
    return "v";
  }
}

let booted: DashboardApp | undefined;
afterAll(async () => {
  await booted?.close();
});

describe("host-owned provider", () => {
  it("keeps the host's service.version on traces and leaves it out of meta", async () => {
    booted = await bootDashboardApp({
      adapter: "express",
      controllers: [HostVersionController],
      nestrix: {
        serviceVersion: "nestrix-2",
        ui: { enabled: true, auth: { token: TOKEN } },
      },
    });
    const api = `${booted.baseUrl}/_nestrix/api/v1`;
    expect((await fetch(`${booted.baseUrl}/h/v`)).status).toBe(200);
    let items: { route?: string; release?: string }[] = [];
    for (let i = 0; i < 100 && items.length === 0; i++) {
      items = ((await get(`${api}/traces`, BEARER)).json() as { items: [] })
        .items;
      if (items.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(items[0]).toMatchObject({ route: "/h/v", release: "host-1" });
    const meta = (await get(`${api}/meta`, BEARER)).json() as {
      service: { version?: string };
      sampling: { owner: string };
    };
    expect(meta.sampling.owner).toBe("host");
    expect(meta.service.version).toBeUndefined();
  });
});
