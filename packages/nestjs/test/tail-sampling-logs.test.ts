// Global state: no host SDK; Nestrix owns the provider (export off), one app at a time.
// D-100: below sampleRate 1 every request records, but the dashboard's log store only gets the
// lines of traces that are exported: a failed trace keeps its lines, a dropped one leaves no
// log-only entry behind.
import { Controller, Get, Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { NestrixLogger } from "../src/logs/logger.js";
import type { TraceLogsResponse } from "../src/store/protocol-types.js";
import { resetStoreForTests } from "../src/store/store.js";
import {
  BEARER,
  bootDashboardApp,
  type DashboardApp,
  get,
} from "./dashboard-fixture.js";
import { captureOutput } from "./logs/helpers.js";

const seen: { ok: string[]; boom: string[] } = { ok: [], boom: [] };
const currentTraceId = () =>
  trace.getActiveSpan()?.spanContext().traceId as string;

@Controller("work")
class WorkController {
  private readonly logger = new Logger("Work");
  @Get("ok")
  ok(): string {
    seen.ok.push(currentTraceId());
    this.logger.log("fine");
    this.logger.log("still fine");
    return "ok";
  }
  @Get("boom")
  boom(): never {
    seen.boom.push(currentTraceId());
    this.logger.log("before failing");
    this.logger.error("it failed");
    throw new Error("boom");
  }
}

let booted: DashboardApp | undefined;
let output: ReturnType<typeof captureOutput> | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
  output?.restore();
  output = undefined;
  seen.ok = [];
  seen.boom = [];
  resetStoreForTests();
});

describe("log lines below sampleRate 1", () => {
  it("keeps the lines of a failed trace and leaves nothing for dropped ones", async () => {
    output = captureOutput();
    booted = await bootDashboardApp({
      adapter: "express",
      nestrix: {
        export: { otlp: false },
        // Nothing but the tail rule keeps a request at this rate.
        sampleRate: 0.0001,
        ui: { enabled: true, auth: { token: "x".repeat(40) } },
      },
      controllers: [WorkController],
      configure: (app) => app.useLogger(new NestrixLogger({ colors: false })),
    });
    const api = `${booted.baseUrl}/_nestrix/api/v1`;
    for (let i = 0; i < 60; i++) {
      expect((await get(`${booted.baseUrl}/work/ok`)).status).toBe(200);
    }
    expect((await get(`${booted.baseUrl}/work/boom`)).status).toBe(500);
    const failed = seen.boom[0] as string;

    let logs: TraceLogsResponse = {
      traceId: failed,
      items: [],
      truncated: false,
    };
    for (let i = 0; i < 100 && logs.items.length < 2; i++) {
      logs = (
        await get(`${api}/trace/logs?id=${failed}`, BEARER)
      ).json() as TraceLogsResponse;
      if (logs.items.length < 2) await new Promise((r) => setTimeout(r, 20));
    }
    // Nest's own log of the unhandled error follows the two lines the controller wrote.
    expect(logs.items.map((l) => l.message).slice(0, 2)).toEqual([
      "before failing",
      "it failed",
    ]);

    // Every ok request was dropped (rate 0.0001): none has a store entry, not even log-only.
    expect(seen.ok).toHaveLength(60);
    for (const traceId of seen.ok) {
      const r = (
        await get(`${api}/trace/logs?id=${traceId}`, BEARER)
      ).json() as TraceLogsResponse;
      expect(r.items).toEqual([]);
    }
  });
});
