// P9-02: the histogram and compare endpoints of the mounted embedded dashboard, on Express.
// Global state: Nestrix owns the provider (export off), one app at a time.
import { afterEach, describe, expect, it } from "vitest";
import { resetDiagnosticsForTests } from "../src/diagnostics.js";
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
  resetDiagnosticsForTests();
});

describe("route insights endpoints (express)", () => {
  it("serves the histogram and the window comparison for counted requests, and closed without a token", async () => {
    booted = await bootDashboardApp({
      adapter: "express",
      nestrix: {
        export: { otlp: false },
        ui: { enabled: true, auth: { token: TOKEN } },
      },
    });
    for (let i = 0; i < 5; i++) await get(`${booted.baseUrl}/h/ok`);
    const api = `${booted.baseUrl}/_nestrix/api/v1/routes`;

    const hist = await get(`${api}/histogram?route=/h/ok&method=GET`, BEARER);
    expect(hist.status).toBe(200);
    expect(headerProblems(hist)).toEqual([]);
    const h = hist.json() as {
      count: number;
      buckets: { count: number }[];
      p95Ms: number;
    };
    expect(h.count).toBe(5);
    expect(h.buckets).toHaveLength(30);
    expect(h.buckets.reduce((n, b) => n + b.count, 0)).toBe(5);

    const cmp = await get(`${api}/compare?windowMinutes=15`, BEARER);
    expect(cmp.status).toBe(200);
    const c = cmp.json() as {
      mode: string;
      routes: { route: string; after: { count: number } }[];
    };
    expect(c.mode).toBe("window");
    expect(c.routes.find((r) => r.route === "/h/ok")?.after.count).toBe(5);

    const missing = await get(`${api}/histogram`, BEARER);
    expect(missing.status).toBe(400);
    expect((await get(`${api}/compare?releaseA=1`, BEARER)).status).toBe(400);
    // The plain routes endpoint is not shadowed by the longer paths.
    expect((await get(api, BEARER)).status).toBe(200);
    // No token: closed, like the rest of the API.
    expect((await get(`${api}/histogram?route=/h/ok`)).status).not.toBe(200);
    expect((await get(`${api}/compare`)).status).not.toBe(200);
  });
});
