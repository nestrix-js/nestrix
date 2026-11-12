// P9-03: `GET <ui path>/api/v1/queries` reads the store's traces, authenticates like the other
// API routes, validates its parameters, and never emits CORS headers. Express only.
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

describe("queries endpoint (express)", () => {
  it("serves aggregated statements; 404 without the token; 400 on bad parameters", async () => {
    booted = await bootDashboardApp({
      adapter: "express",
      nestrix: {
        export: { otlp: false as const },
        ui: { enabled: true, auth: { token: TOKEN } },
      },
      cors: true,
    });
    const api = `${booted.baseUrl}/_nestrix/api/v1/queries`;
    expect((await get(`${booted.baseUrl}${booted.hostOk}`)).status).toBe(200);
    const store = getStore();
    expect(store).toBeDefined();

    const root = serverRoot(901, { startMs: Date.now() - 1000 });
    store?.enqueue(root);
    for (let i = 0; i < 3; i++) {
      store?.enqueue(
        fakeSpan({
          trace: 901,
          parent: { spanId: root.spanContext().spanId },
          kind: 2,
          startMs: Date.now() - 900,
          durationMs: 7,
          attributes: {
            "db.system.name": "postgresql",
            "db.query.text": "SELECT * FROM t WHERE id = ?",
          },
        }),
      );
    }
    store?.drainNow();

    const r = await get(api, BEARER);
    expect(r.status).toBe(200);
    expect(headerProblems(r)).toEqual([]);
    const body = r.json() as {
      sampled: boolean;
      windowMinutes: number;
      queries: { statement: string; count: number; repeatedTraces: number }[];
    };
    expect(body.sampled).toBe(true);
    expect(body.windowMinutes).toBe(15);
    expect(body.queries).toMatchObject([
      {
        statement: "SELECT * FROM t WHERE id = ?",
        count: 3,
        repeatedTraces: 1,
      },
    ]);

    const other = await get(`${api}?service=nope`, BEARER);
    expect((other.json() as { queries: unknown[] }).queries).toEqual([]);
    expect(
      (
        (await get(`${api}?sort=count&limit=1`, BEARER)).json() as {
          queries: unknown[];
        }
      ).queries,
    ).toHaveLength(1);

    const denied = await get(api);
    expect(denied.status).toBe(404);
    expect(denied.text).not.toContain("SELECT");

    for (const bad of ["sort=nope", "limit=0", "windowMinutes=30"]) {
      expect((await get(`${api}?${bad}`, BEARER)).status).toBe(400);
    }
  });
});
