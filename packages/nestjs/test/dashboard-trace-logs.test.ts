// Global state: no host SDK; Nestrix owns the provider (export off), one app at a time.
// P9-07: `GET <ui path>/api/v1/trace/logs?id=` on Express serves the NestrixLogger lines written
// during a request, next to their trace: redacted, with span ids, nothing from outside a request;
// authenticated like the other routes, validated, no CORS headers.
import { Controller, Get, Logger } from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";
import { NestrixLogger } from "../src/logs/logger.js";
import type {
  TraceListResponse,
  TraceLogsResponse,
  TraceResponse,
} from "../src/store/protocol-types.js";
import { resetStoreForTests } from "../src/store/store.js";
import {
  BEARER,
  bootDashboardApp,
  type DashboardApp,
  get,
  headerProblems,
  TOKEN,
} from "./dashboard-fixture.js";
import { captureOutput } from "./logs/helpers.js";

@Controller("work")
class WorkController {
  private readonly logger = new Logger("Work");
  @Get()
  work(): string {
    this.logger.log("starting work");
    this.logger.warn({ user: "ann", password: "hunter2" });
    this.logger.error("it failed");
    return "ok";
  }
}

let booted: DashboardApp | undefined;
let output: ReturnType<typeof captureOutput> | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
  output?.restore();
  output = undefined;
  resetStoreForTests();
});

describe("express: trace logs endpoint", () => {
  it("serves a request's log lines with their trace", async () => {
    output = captureOutput();
    booted = await bootDashboardApp({
      adapter: "express",
      nestrix: {
        export: { otlp: false },
        ui: { enabled: true, auth: { token: TOKEN } },
      },
      controllers: [WorkController],
      configure: (app) =>
        app.useLogger(
          new NestrixLogger({ colors: false, redact: ["password"] }),
        ),
    });
    const api = `${booted.baseUrl}/_nestrix/api/v1`;
    new Logger("Boot").log("outside any request");
    expect((await get(`${booted.baseUrl}/work`)).status).toBe(200);

    let list: TraceListResponse = {
      items: [],
      head: null,
      older: null,
      reset: false,
    };
    for (let i = 0; i < 100 && list.items.length === 0; i++) {
      list = (await get(`${api}/traces`, BEARER)).json() as TraceListResponse;
      if (list.items.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    const id = list.items[0]?.traceId as string;
    expect(id).toMatch(/^[0-9a-f]{32}$/);

    const r = await get(`${api}/trace/logs?id=${id}`, BEARER);
    expect(r.status).toBe(200);
    expect(headerProblems(r)).toEqual([]);
    const body = r.json() as TraceLogsResponse;
    expect(body.traceId).toBe(id);
    expect(body.truncated).toBe(false);
    expect(body.items.map((l) => [l.level, l.severity, l.context])).toEqual([
      ["log", 9, "Work"],
      ["warn", 13, "Work"],
      ["error", 17, "Work"],
    ]);
    expect(body.items[0]?.message).toBe("starting work");
    expect(body.items[1]?.message).toContain("[REDACTED]");
    expect(r.text).not.toContain("hunter2");
    expect(r.text).not.toContain("outside any request");
    // Each line names a span of the trace.
    const trace = (
      await get(`${api}/trace?id=${id}`, BEARER)
    ).json() as TraceResponse;
    const spanIds = new Set(trace.spans.map((s) => s.spanId));
    for (const l of body.items)
      expect(spanIds.has(l.spanId as string)).toBe(true);
  });

  it("is closed without the token, validates the id, answers empty for an unknown trace", async () => {
    booted = await bootDashboardApp({
      adapter: "express",
      nestrix: {
        export: { otlp: false },
        ui: { enabled: true, auth: { token: TOKEN } },
      },
      cors: true,
    });
    const api = `${booted.baseUrl}/_nestrix/api/v1/trace/logs`;
    const id = "a".repeat(32);
    const closed = await get(`${api}?id=${id}`, {
      origin: "http://evil.example",
    });
    expect(closed.status).toBe(404);
    expect(closed.text).not.toContain("items");
    for (const bad of ["", "?id=xyz", `?id=${id}&id=${id}`, `?id=${id}&x=1`]) {
      const r = await get(`${api}${bad}`, BEARER);
      expect(r.status).toBe(400);
      expect(headerProblems(r)).toEqual([]);
    }
    const empty = await get(`${api}?id=${id}`, BEARER);
    expect(empty.status).toBe(200);
    expect(empty.json()).toEqual({ traceId: id, items: [], truncated: false });
  });
});
