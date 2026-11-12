// Global state: no host SDK; Nestrix owns the provider (export off), one app at a time.
// P9-04: `GET <ui path>/api/v1/errors/groups` groups the store's error items, authenticates like
// the other API routes, validates `windowMinutes`, and never emits CORS headers.
import { afterEach, describe, expect, it } from "vitest";
import { getStore, resetStoreForTests } from "../src/store/store.js";
import {
  BEARER,
  bootDashboardApp,
  type DashboardApp,
  get,
  headerProblems,
  TOKEN,
} from "./dashboard-fixture.js";
import { fakeSpan } from "./store-helpers.js";

let booted: DashboardApp | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
  resetStoreForTests();
});

const ENABLED = {
  export: { otlp: false as const },
  ui: { enabled: true, auth: { token: TOKEN } },
};

interface Body {
  windowMinutes: number;
  bucketMs: number;
  groups: {
    errorType?: string;
    pattern: string;
    route?: string;
    count: number;
    series: number[];
    services: string[];
    exampleTraceId: string;
    latestMessage?: string;
    recent: { traceId: string }[];
  }[];
}

describe("errors/groups (express)", () => {
  it("groups, authenticates, validates and sends no CORS headers", async () => {
    booted = await bootDashboardApp({
      adapter: "express",
      nestrix: ENABLED,
      cors: true,
    });
    const api = `${booted.baseUrl}/_nestrix/api/v1/errors/groups`;
    expect((await get(`${booted.baseUrl}${booted.hostOk}`)).status).toBe(200);
    const store = getStore();
    expect(store).toBeDefined();

    const now = Date.now();
    const failing = (trace: number, id: number, route: string) =>
      fakeSpan({
        trace,
        startMs: now - 5000 - trace,
        attributes: { "http.route": route, "http.request.method": "GET" },
        status: { code: 2 },
        events: [
          {
            name: "exception",
            timeMs: now - 4000 - trace,
            attributes: {
              "exception.type": "NotFoundException",
              "exception.message": `user ${id} not found`,
            },
          },
        ],
      });
    store?.enqueue(failing(901, 42, "/users/:id"));
    store?.enqueue(failing(902, 7, "/users/:id"));
    store?.enqueue(failing(903, 8, "/accounts/:id"));
    store?.drainNow();

    const r = await get(api, BEARER);
    expect(r.status).toBe(200);
    expect(headerProblems(r)).toEqual([]);
    const body = r.json() as Body;
    expect(body.windowMinutes).toBe(15);
    expect(body.bucketMs).toBe(60_000);
    expect(body.groups).toHaveLength(2);
    expect(body.groups[0]).toMatchObject({
      errorType: "NotFoundException",
      pattern: "user <n> not found",
      route: "/users/:id",
      count: 2,
      recent: [
        { traceId: expect.any(String) },
        { traceId: expect.any(String) },
      ],
    });
    expect(body.groups[0]?.series).toHaveLength(15);
    expect(body.groups[0]?.series.reduce((a, b) => a + b, 0)).toBe(2);
    expect(body.groups[1]).toMatchObject({
      route: "/accounts/:id",
      count: 1,
      latestMessage: "user 8 not found",
    });

    const long = (await get(`${api}?windowMinutes=60`, BEARER)).json() as Body;
    expect(long.bucketMs).toBe(300_000);
    expect(long.groups[0]?.series).toHaveLength(12);

    // Another service's name answers empty; this application's own name changes nothing.
    const other = (await get(`${api}?service=nope`, BEARER)).json() as Body;
    expect(other.groups).toEqual([]);

    const denied = await get(api);
    expect(denied.status).toBe(404);
    expect(denied.text).not.toContain("NotFound");

    const bad = await get(`${api}?windowMinutes=30`, BEARER);
    expect(bad.status).toBe(400);
    expect(bad.json()).toEqual({
      error: {
        code: "bad_request",
        message: 'Query parameter "windowMinutes" must be one of 15, 60.',
      },
    });
  });
});
