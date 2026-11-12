// Global state: no host SDK; Nestrix owns the provider (export off), one app at a time.
// P3-05: `GET <ui path>/api/v1/map` reads the store's traces, authenticates like the other API
// routes, validates `windowMinutes`, and never emits CORS headers.
import { afterEach, describe, expect, it } from "vitest";
import { getStore, resetStoreForTests } from "../src/store/store.js";
import {
  ADAPTERS,
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

describe.each(ADAPTERS)("%s", (adapter) => {
  it("serves the map; 404 without the token; 400 on a bad window", async () => {
    booted = await bootDashboardApp({ adapter, nestrix: ENABLED, cors: true });
    const api = `${booted.baseUrl}/_nestrix/api/v1/map`;
    // The store is created with the provider; a request to the host makes sure it is wired.
    expect((await get(`${booted.baseUrl}${booted.hostOk}`)).status).toBe(200);
    const store = getStore();
    expect(store).toBeDefined();

    const root = serverRoot(900, { startMs: Date.now() - 1000 });
    store?.enqueue(root);
    for (const error of [false, true]) {
      store?.enqueue(
        fakeSpan({
          trace: 900,
          parent: { spanId: root.spanContext().spanId },
          kind: 2,
          startMs: Date.now() - 900,
          durationMs: 12,
          attributes: {
            "db.system.name": "postgresql",
            "server.address": "db.local",
            "server.port": 5432,
            "db.namespace": "shop",
          },
          status: { code: error ? 2 : 0 },
        }),
      );
    }
    store?.drainNow();

    const r = await get(api, BEARER);
    expect(r.status).toBe(200);
    expect(headerProblems(r)).toEqual([]);
    const body = r.json() as {
      windowMinutes: number;
      nodes: { id: string; kind: string }[];
      edges: { to: string; calls: number; errors: number }[];
    };
    expect(body.windowMinutes).toBe(15);
    expect(body).toMatchObject({ previousCovered: false });
    expect(body.nodes.map((n) => [n.id, n.kind])).toEqual([
      ["app", "app"],
      ["db:postgresql:db.local:5432/shop", "database"],
    ]);
    expect(body.edges).toMatchObject([
      { to: "db:postgresql:db.local:5432/shop", calls: 2, errors: 1 },
    ]);

    expect(
      (
        (await get(`${api}?windowMinutes=60`, BEARER)).json() as {
          windowMinutes: number;
        }
      ).windowMinutes,
    ).toBe(60);

    const denied = await get(api);
    expect(denied.status).toBe(404);
    expect(denied.text).not.toContain("postgresql");

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
