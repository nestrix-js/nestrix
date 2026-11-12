// P9-05: `GET <ui path>/api/v1/dependencies` and `/traces/timeline` read the store, authenticate
// like the other API routes, validate their parameters and never emit CORS headers.
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
import { fakeSpan, serverRoot } from "./store-helpers.js";

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

describe("dependencies and timeline (express)", () => {
  it("serves both; 404 without the token; 400 on bad parameters", async () => {
    booted = await bootDashboardApp({
      adapter: "express",
      nestrix: ENABLED,
      cors: true,
    });
    const base = `${booted.baseUrl}/_nestrix/api/v1`;
    expect((await get(`${booted.baseUrl}${booted.hostOk}`)).status).toBe(200);
    const store = getStore();
    const root = serverRoot(901, {
      startMs: Date.now() - 1000,
      attributes: {
        "http.request.method": "GET",
        "http.route": "/x",
        "http.response.status_code": 404,
      },
    });
    store?.enqueue(root);
    store?.enqueue(
      fakeSpan({
        trace: 901,
        parent: { spanId: root.spanContext().spanId },
        kind: 2,
        startMs: Date.now() - 900,
        durationMs: 20,
        attributes: {
          "server.address": "api.stripe.com",
          "http.request.method": "POST",
        },
      }),
    );
    store?.drainNow();
    const json = async <T>(url: string) => (await get(url, BEARER)).json() as T;

    const deps = await get(`${base}/dependencies`, BEARER);
    expect(deps.status).toBe(200);
    expect(headerProblems(deps)).toEqual([]);
    const body = deps.json() as {
      bucketMs: number;
      dependencies: { id: string; calls: number; series: unknown[] }[];
    };
    expect(body.bucketMs).toBe(60_000);
    // A process that just started has no previous window to compare with.
    expect(deps.json()).toMatchObject({ previousCovered: false });
    expect(body.dependencies).toMatchObject([
      { id: "http:api.stripe.com", calls: 1 },
    ]);
    expect(body.dependencies[0]?.series).toHaveLength(15);
    expect(
      (
        await json<{ bucketMs: number }>(
          `${base}/dependencies?windowMinutes=60`,
        )
      ).bucketMs,
    ).toBe(300_000);
    expect(
      (
        await json<{ dependencies: unknown[] }>(
          `${base}/dependencies?service=other`,
        )
      ).dependencies,
    ).toEqual([]);

    const tl = await get(`${base}/traces/timeline`, BEARER);
    expect(tl.status).toBe(200);
    expect(headerProblems(tl)).toEqual([]);
    const sum = (r: { buckets: { clientError: number }[] }) =>
      r.buckets.reduce((n, b) => n + b.clientError, 0);
    const timeline = tl.json() as { buckets: { clientError: number }[] };
    expect(timeline.buckets).toHaveLength(15);
    expect(sum(timeline)).toBe(1);
    expect(sum(await json(`${base}/traces/timeline?status=5xx`))).toBe(0);

    // The trace list takes a time range.
    const now = Date.now();
    const inRange = await json<{ items: { route?: string }[] }>(
      `${base}/traces?fromUnixMs=${now - 5000}&toUnixMs=${now + 5000}`,
    );
    expect(inRange.items.map((i) => i.route)).toContain("/x");
    const before = await json<{ items: unknown[] }>(
      `${base}/traces?toUnixMs=${now - 60_000}`,
    );
    expect(before.items).toHaveLength(0);

    expect((await get(`${base}/dependencies`)).status).toBe(404);
    expect((await get(`${base}/traces/timeline`)).status).toBe(404);
    expect(
      (await get(`${base}/dependencies?windowMinutes=30`, BEARER)).status,
    ).toBe(400);
    expect(
      (await get(`${base}/traces/timeline?status=bad`, BEARER)).status,
    ).toBe(400);
    expect((await get(`${base}/traces?fromUnixMs=abc`, BEARER)).status).toBe(
      400,
    );
  });
});
