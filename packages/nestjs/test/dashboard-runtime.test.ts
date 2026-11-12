// P9-06: `GET <ui path>/api/v1/runtime` on a real host: authenticates like the other API routes,
// never emits CORS headers, and `meta.runtime.available` is true.
import { afterEach, describe, expect, it } from "vitest";
import { resetStoreForTests } from "../src/store/store.js";
import {
  BEARER,
  bootDashboardApp,
  type DashboardApp,
  get,
  headerProblems,
  TOKEN,
} from "./dashboard-fixture.js";

let booted: DashboardApp | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
  resetStoreForTests();
});

describe("runtime endpoint (express)", () => {
  it("serves the runtime document, 404 without the token, 400 on a parameter, no CORS", async () => {
    booted = await bootDashboardApp({
      adapter: "express",
      nestrix: {
        export: { otlp: false as const },
        ui: { enabled: true, auth: { token: TOKEN } },
      },
      cors: true,
    });
    const api = `${booted.baseUrl}/_nestrix/api/v1`;

    const r = await get(`${api}/runtime`, BEARER);
    expect(r.status).toBe(200);
    expect(headerProblems(r)).toEqual([]);
    const body = r.json() as {
      intervalMs: number;
      retentionMinutes: number;
      samples: unknown[];
      current: unknown;
      process: { uptimeSeconds: number; nodeVersion: string };
    };
    expect(body.intervalMs).toBe(10_000);
    expect(body.retentionMinutes).toBe(60);
    expect(Array.isArray(body.samples)).toBe(true);
    expect(body.process.nodeVersion).toBe(process.version);
    expect(body.process.uptimeSeconds).toBeGreaterThanOrEqual(0);

    const meta = (await get(`${api}/meta`, BEARER)).json() as {
      runtime?: { available: boolean };
    };
    expect(meta.runtime).toEqual({ available: true });

    const denied = await get(`${api}/runtime`);
    expect(denied.status).toBe(404);
    expect(denied.text).not.toContain("nodeVersion");

    expect((await get(`${api}/runtime?x=1`, BEARER)).status).toBe(400);
  });
});
