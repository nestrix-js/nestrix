// Global state: no host SDK; Nestrix owns the provider (export off), one app at a time.
// P15-02: `GET <ui path>/api/v1/errors/insights` (weekday x hour grid, errors per release) and the
// state and releases on `errors/groups`, over the spans the store holds.

import { afterEach, describe, expect, it } from "vitest";
import type {
  ErrorGroupsResponse,
  ErrorInsightsResponse,
} from "../src/store/protocol-types.js";
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
const HOUR = 3_600_000;

describe("errors/insights and group state (express)", () => {
  it("counts by weekday and hour and per release, and states the groups", async () => {
    booted = await bootDashboardApp({
      adapter: "express",
      nestrix: ENABLED,
      cors: true,
    });
    expect((await get(`${booted.baseUrl}${booted.hostOk}`)).status).toBe(200);
    const store = getStore();
    const now = Date.now();
    const resource = (version: string) => ({
      "service.name": "store-test",
      "service.version": version,
    });
    const request = (
      trace: number,
      ago: number,
      version: string,
      route: string,
      failing: boolean,
    ) =>
      fakeSpan({
        trace,
        kind: 1,
        startMs: now - ago,
        resource: resource(version),
        attributes: { "http.route": route, "http.request.method": "GET" },
        ...(failing
          ? {
              status: { code: 2 },
              events: [
                {
                  name: "exception",
                  timeMs: now - ago + 1,
                  attributes: {
                    "exception.type": "BoomError",
                    "exception.message": `order ${trace} failed`,
                  },
                },
              ],
            }
          : {}),
      });
    // 1.0.0: 4 requests, 2 failing, a day ago. 1.1.0: 2 requests, 1 failing, a minute ago;
    // plus the same error that happened a day ago comes back.
    store?.enqueue(request(1, 26 * HOUR, "1.0.0", "/orders", true));
    store?.enqueue(request(2, 25 * HOUR, "1.0.0", "/orders", true));
    store?.enqueue(request(3, 25 * HOUR, "1.0.0", "/users", false));
    store?.enqueue(request(4, 25 * HOUR, "1.0.0", "/users", false));
    store?.enqueue(request(5, 60_000, "1.1.0", "/orders", true));
    store?.enqueue(request(6, 50_000, "1.1.0", "/users", false));
    store?.drainNow();

    const api = `${booted.baseUrl}/_nestrix/api/v1/errors`;
    const r = await get(`${api}/insights`, BEARER);
    expect(r.status).toBe(200);
    expect(headerProblems(r)).toEqual([]);
    const body = r.json() as ErrorInsightsResponse;
    expect(body.zone).toBe("UTC");
    expect(body.total).toBe(3);
    expect(body.heatmap).toHaveLength(7);
    expect(body.heatmap.flat().reduce((a, b) => a + b, 0)).toBe(3);
    const rel = (r: ErrorInsightsResponse, name: string) =>
      r.releases.find((x) => x.release === name);
    // The host's own request may be listed as a release of its own (0.2.0, newest); ignore it.
    expect(
      body.releases.map((x) => x.release).filter((x) => x !== "0.2.0"),
    ).toEqual(["1.0.0", "1.1.0"]);
    expect(rel(body, "1.0.0")).toMatchObject({
      events: 2,
      requests: 4,
      per1000Requests: 500,
    });
    expect(rel(body, "1.1.0")).toMatchObject({
      events: 1,
      requests: 2,
      per1000Requests: 500,
    });
    expect(body.coveredFromUnixMs).toBeLessThanOrEqual(now - 25 * HOUR);

    // The route filter narrows events and requests.
    const users = (
      await get(`${api}/insights?route=${encodeURIComponent("/users")}`, BEARER)
    ).json() as ErrorInsightsResponse;
    expect(users.total).toBe(0);
    const orders = (
      await get(
        `${api}/insights?route=${encodeURIComponent("/orders")}`,
        BEARER,
      )
    ).json() as ErrorInsightsResponse;
    expect(orders.total).toBe(3);
    expect(rel(orders, "1.0.0")).toMatchObject({ requests: 2, events: 2 });

    // Another service answers an empty grid.
    const other = (
      await get(`${api}/insights?service=nope`, BEARER)
    ).json() as ErrorInsightsResponse;
    expect(other.total).toBe(0);
    expect(other.releases).toEqual([]);

    // Auth and validation like the other routes.
    expect((await get(`${api}/insights`)).status).toBe(404);
    expect(
      (await get(`${api}/insights?route=${"x".repeat(600)}`, BEARER)).status,
    ).toBe(400);

    // The group of "order <n> failed" was seen a day ago and is back: regressed, with releases.
    const groups = (
      await get(`${api}/groups`, BEARER)
    ).json() as ErrorGroupsResponse;
    expect(groups.groups).toHaveLength(1);
    expect(groups.groups[0]).toMatchObject({
      count: 1,
      state: "regressed",
      firstSeenRelease: "1.0.0",
      lastSeenRelease: "1.1.0",
      releases: [{ release: "1.1.0", count: 1 }],
    });
    expect(groups.groups[0]?.firstEverUnixMs).toBeLessThan(now - 25 * HOUR);
    expect(groups.history?.fromUnixMs).toBeLessThan(now - 25 * HOUR);
  });
});
