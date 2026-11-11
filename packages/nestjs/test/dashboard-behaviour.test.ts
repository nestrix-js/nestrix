// Global state: no host SDK; Nestrix owns the provider (export off), one app at a time.
// `NODE_ENV` is stubbed per test (resolveOptions reads it when the module is created), and
// Nest's `Logger.prototype` is spied on to read Nestrix's log lines.
//
// P2-06: a handler fault answers 500 without reaching the host's filter; Express catch-all
// shadowing is logged after one visit; NODE_ENV=production with 'auto' registers nothing; no
// HTTP adapter registers nothing and detaches the store; @nestrix/ui missing or broken; the
// 'auto' startup-token flow; the startup log line; the access timeout; API parameter errors.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiPackage } from "../src/dashboard/assets.js";
import { dashboardFaults, dashboardTimings } from "../src/dashboard/mount.js";
import { getProcessStartupToken } from "../src/dashboard/startup-token.js";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import { NestrixModule } from "../src/nestrix.module.js";
import { getStore } from "../src/store/store.js";
import {
  ADAPTERS,
  BEARER,
  bootDashboardApp,
  CatchAllController,
  type DashboardApp,
  EVIL_ORIGIN,
  get,
  HostController,
  headerProblems,
  hostFilter,
  TOKEN,
  waitFor,
} from "./dashboard-fixture.js";

const realResolve = uiPackage.resolveDirectory;
const timings = { ...dashboardTimings };
let booted: DashboardApp | undefined;
let logs: string[];
let errors: string[];

beforeEach(() => {
  resetDiagnosticsForTests();
  hostFilter.calls = 0;
  logs = [];
  errors = [];
  vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
    logs.push(String(message));
  });
  vi.spyOn(Logger.prototype, "error").mockImplementation((message: unknown) => {
    errors.push(String(message));
  });
});
afterEach(async () => {
  dashboardFaults.site = undefined;
  Object.assign(dashboardTimings, timings);
  uiPackage.resolveDirectory = realResolve;
  await booted?.close();
  booted = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const ENABLED = {
  export: { otlp: false as const },
  ui: { enabled: true, auth: { token: TOKEN } },
};

describe.each(ADAPTERS)("%s", (adapter) => {
  it.each([["handler"], ["handler-sync"]] as const)(
    "a fault at %s answers 500 itself; the host's filter is not called",
    async (site) => {
      booted = await bootDashboardApp({
        adapter,
        nestrix: ENABLED,
        filter: true,
        cors: true,
      });
      // The host filter works for host routes.
      const hostBoom = await get(`${booted.baseUrl}/h/boom`);
      expect(hostBoom.text).toBe("host-filter");
      expect(hostFilter.calls).toBe(1);

      dashboardFaults.site = site;
      const api = await get(`${booted.baseUrl}/_nestrix/api/v1/meta`, {
        ...BEARER,
        origin: EVIL_ORIGIN,
      });
      expect(api.status).toBe(500);
      expect(api.json()).toEqual({
        error: {
          code: "internal",
          message: "The dashboard could not answer this request.",
        },
      });
      expect(headerProblems(api)).toEqual([]);
      const page = await get(`${booted.baseUrl}/_nestrix/`, {
        ...BEARER,
        origin: EVIL_ORIGIN,
      });
      expect(page.status).toBe(500);
      expect(page.body.length).toBe(0);
      expect(headerProblems(page)).toEqual([]);
      expect(hostFilter.calls).toBe(1);
      expect(getFailureCounts().get("dashboard.handler")).toBe(2);

      // The next request is served normally.
      dashboardFaults.site = undefined;
      const ok = await get(`${booted.baseUrl}/_nestrix/api/v1/meta`, BEARER);
      expect(ok.status).toBe(200);
    },
  );

  it("NODE_ENV=production with 'auto': nothing registered, the app starts, one line says why", async () => {
    vi.stubEnv("NODE_ENV", "production");
    booted = await bootDashboardApp({
      adapter,
      nestrix: { export: { otlp: false } },
    });
    expect((await get(`${booted.baseUrl}/h/ok`)).text).toBe("ok");
    for (const path of [
      "/_nestrix/",
      "/_nestrix/api/v1/meta",
      "/_nestrix/auth",
    ]) {
      const r = await get(`${booted.baseUrl}${path}`);
      expect(r.status).toBe(404);
      // Nest's own 404, not a dashboard response.
      expect(r.headers.get("x-robots-tag")).toBeNull();
    }
    expect(logs.filter((l) => l.startsWith("Nestrix dashboard:"))).toEqual([
      "Nestrix dashboard: off, because NODE_ENV is \"production\" and ui is 'auto', which serves it only when NODE_ENV is development or unset. ui: { enabled: true, auth } serves it in any environment.",
    ]);
    expect(getStore()?.stats().attached ?? 0).toBe(0);
  });

  it("enabled without auth: off, an error line, the app starts", async () => {
    booted = await bootDashboardApp({
      adapter,
      nestrix: { export: { otlp: false }, ui: { enabled: true } },
    });
    expect((await get(`${booted.baseUrl}/h/ok`)).text).toBe("ok");
    expect((await get(`${booted.baseUrl}/_nestrix/`)).status).toBe(404);
    expect(errors.some((e) => e.includes("ui.auth is missing"))).toBe(true);
  });

  it("@nestrix/ui not installed: off with the install command, nothing registered", async () => {
    uiPackage.resolveDirectory = () => undefined;
    booted = await bootDashboardApp({ adapter, nestrix: ENABLED });
    expect((await get(`${booted.baseUrl}/_nestrix/`, BEARER)).status).toBe(404);
    expect(logs).toContain(
      "Nestrix dashboard: off, because @nestrix/ui is not installed. Install it at the same version as @nestrix/nestjs to serve the dashboard: npm install @nestrix/ui",
    );
    expect(getStore()?.stats().attached ?? 0).toBe(0);
  });

  it("@nestrix/ui broken (a file does not match the manifest): off with an error, store detached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nestrix-ui-"));
    const real = realResolve() as string;
    const manifest = JSON.parse(
      readFileSync(join(real, "manifest.json"), "utf8"),
    );
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    uiPackage.resolveDirectory = () => dir;
    booted = await bootDashboardApp({ adapter, nestrix: ENABLED });
    expect((await get(`${booted.baseUrl}/_nestrix/`, BEARER)).status).toBe(404);
    expect(
      errors.some((e) =>
        e.startsWith("Nestrix dashboard: off. @nestrix/ui could not be loaded"),
      ),
    ).toBe(true);
    expect(getStore()?.stats().attached).toBe(0);
  });

  it("'auto': 403 without the startup cookie, the exchange sets it and redirects, then data loads; the link names the real port", async () => {
    vi.stubEnv("NODE_ENV", "development");
    booted = await bootDashboardApp({
      adapter,
      nestrix: { export: { otlp: false } },
      cors: true,
    });
    const base = booted.baseUrl;
    const token = getProcessStartupToken().token;
    await waitFor(() =>
      logs.some((l) => l.startsWith("Nestrix dashboard: http")),
    );
    expect(logs).toContain(
      `Nestrix dashboard: http://localhost:${booted.port}/_nestrix/auth?token=${token}`,
    );

    const page = await get(`${base}/_nestrix/`, { origin: EVIL_ORIGIN });
    expect(page.status).toBe(403);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.text).toContain("startup link");
    expect(page.text).not.toContain("<script");
    expect(headerProblems(page)).toEqual([]);
    const api = await get(`${base}/_nestrix/api/v1/meta`);
    expect(api.status).toBe(403);
    expect((api.json() as { error: { code: string } }).error.code).toBe(
      "forbidden",
    );
    expect(headerProblems(api)).toEqual([]);

    const wrong = await get(`${base}/_nestrix/auth?token=wrong`);
    expect(wrong.status).toBe(403);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const exchange = await get(`${base}/_nestrix/auth?token=${token}`, {
      origin: EVIL_ORIGIN,
    });
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get("location")).toBe("/_nestrix/");
    expect(exchange.body.length).toBe(0);
    expect(headerProblems(exchange)).toEqual([]);
    const setCookie = exchange.headers.get("set-cookie") as string;
    expect(setCookie).toMatch(
      new RegExp(
        `^nestrix_session_${booted.port}=[A-Za-z0-9_-]+; Path=/_nestrix; HttpOnly; SameSite=Strict$`,
      ),
    );
    const cookie = setCookie.split(";")[0] as string;

    const index = await get(`${base}/_nestrix/`, { cookie });
    expect(index.status).toBe(200);
    const meta = await get(`${base}/_nestrix/api/v1/meta`, { cookie });
    expect(meta.status).toBe(200);
    // Cross-site is denied even with the cookie (D-30).
    const cross = await get(`${base}/_nestrix/api/v1/meta`, {
      cookie,
      "sec-fetch-site": "cross-site",
    });
    expect(cross.status).toBe(404);
    expect(cross.body.length).toBe(0);
    // A forwarded request is denied even with the cookie.
    const forwarded = await get(`${base}/_nestrix/api/v1/meta`, {
      cookie,
      "x-forwarded-for": "203.0.113.9",
    });
    expect(forwarded.status).toBe(404);
  });

  it("never listening: the line gives the path and says the link needs a listening server", async () => {
    vi.stubEnv("NODE_ENV", "development");
    dashboardTimings.listenGraceMs = 20;
    booted = await bootDashboardApp({
      adapter,
      nestrix: { export: { otlp: false } },
      listen: false,
    });
    await waitFor(() =>
      logs.some((l) => l.startsWith("Nestrix dashboard: served")),
    );
    const lines = logs.filter((l) => l.startsWith("Nestrix dashboard:"));
    expect(lines).toEqual([
      "Nestrix dashboard: served at /_nestrix/ once the application listens; the startup-token link needs a listening server (call app.listen()).",
    ]);
    expect(lines.join("\n")).not.toContain(getProcessStartupToken().token);
  });

  it("a slow start: the tokenless line after the grace period, then the token link with the real port once", async () => {
    vi.stubEnv("NODE_ENV", "development");
    dashboardTimings.listenGraceMs = 20;
    booted = await bootDashboardApp({
      adapter,
      nestrix: { export: { otlp: false } },
      listen: false,
    });
    await waitFor(() =>
      logs.some((l) => l.startsWith("Nestrix dashboard: served")),
    );
    const token = getProcessStartupToken().token;
    expect(logs.join("\n")).not.toContain(token);
    await booted.app.listen(0, "127.0.0.1");
    const port = (booted.app.getHttpServer().address() as { port: number })
      .port;
    await waitFor(() => logs.some((l) => l.includes("/auth?token=")));
    const links = logs.filter((l) => l.includes("/auth?token="));
    expect(links).toEqual([
      `Nestrix dashboard: http://localhost:${port}/_nestrix/auth?token=${token}`,
    ]);
    expect(
      logs.filter((l) => l.startsWith("Nestrix dashboard: served")),
    ).toHaveLength(1);
  });

  it("an authorize that never settles is denied after the timeout; authorize sees the adapter's request", async () => {
    dashboardTimings.accessTimeoutMs = 50;
    const seen: unknown[] = [];
    booted = await bootDashboardApp({
      adapter,
      nestrix: {
        export: { otlp: false },
        ui: {
          enabled: true,
          auth: {
            authorize: (request: unknown) => {
              seen.push(request);
              const raw =
                (request as { raw?: { headers: Record<string, string> } })
                  .raw ?? (request as { headers: Record<string, string> });
              if (raw.headers["x-hang"]) return new Promise<boolean>(() => {});
              if (raw.headers["x-throw"]) throw new Error("authorize fault");
              return raw.headers["x-allow"] === "yes";
            },
          },
        },
      },
    });
    const started = Date.now();
    const hang = await get(`${booted.baseUrl}/_nestrix/api/v1/meta`, {
      "x-hang": "1",
    });
    expect(hang.status).toBe(404);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(
      (await get(`${booted.baseUrl}/_nestrix/api/v1/meta`, { "x-throw": "1" }))
        .status,
    ).toBe(404);
    expect(
      (
        await get(`${booted.baseUrl}/_nestrix/api/v1/meta`, {
          "x-allow": "yes",
        })
      ).status,
    ).toBe(200);
    expect(seen.length).toBe(3);
    if (adapter === "fastify") expect(seen[0]).toHaveProperty("raw");
    else expect(seen[0]).toHaveProperty("socket");
    expect(hostFilter.calls).toBe(0);
  });

  it("API parameters: unknown, malformed, out of range, repeated, before with after, missing id", async () => {
    booted = await bootDashboardApp({
      adapter,
      nestrix: { ...ENABLED, ignore: { routes: ["/health"] } },
    });
    const api = `${booted.baseUrl}/_nestrix/api/v1`;
    const cases: [string, string][] = [
      ["/meta?x=1", 'Unknown query parameter "x".'],
      ["/traces?limit=0", 'Query parameter "limit" must be between 1 and 200.'],
      ["/traces?limit=abc", 'Query parameter "limit" must be an integer.'],
      [
        "/traces?limit=1&limit=2",
        'Query parameter "limit" is given more than once.',
      ],
      [
        "/traces?status=teapot",
        'Query parameter "status" must be one of ok, error, 4xx, 5xx.',
      ],
      [
        "/traces?minDurationMs=-1",
        'Query parameter "minDurationMs" must be between 0 and 86400000.',
      ],
      [
        "/traces?before=a&after=b",
        'Query parameters "before" and "after" cannot be used together.',
      ],
      [
        `/traces?search=${"s".repeat(201)}`,
        'Query parameter "search" must be at most 200 characters.',
      ],
      ["/errors?before=", 'Query parameter "before" must not be empty.'],
      [
        "/routes?windowMinutes=30",
        'Query parameter "windowMinutes" must be one of 15, 60.',
      ],
      ["/trace", 'Query parameter "id" is required.'],
      ["/trace?id=XYZ", 'Query parameter "id" is malformed.'],
    ];
    for (const [path, message] of cases) {
      const r = await get(`${api}${path}`, BEARER);
      expect(r.status, path).toBe(400);
      expect(r.json(), path).toEqual({
        error: { code: "bad_request", message },
      });
      expect(headerProblems(r), path).toEqual([]);
    }
    // A foreign cursor is not an error: the list answers reset.
    const reset = await get(`${api}/traces?after=elsewhere.t1`, BEARER);
    expect(reset.status).toBe(200);
    expect(reset.json()).toMatchObject({ reset: true });
    // Empty string filters are no filter.
    expect((await get(`${api}/traces?search=&route=`, BEARER)).status).toBe(
      200,
    );
    const meta = (await get(`${api}/meta`, BEARER)).json() as {
      warnings: { code: string }[];
    };
    expect(meta.warnings.map((w) => w.code)).toEqual(["ignored-routes"]);
  });
});

describe("shadowing", () => {
  it("Express: a host catch-all shadows the dashboard; logged once after one visit", async () => {
    booted = await bootDashboardApp({
      adapter: "express",
      nestrix: ENABLED,
      controllers: [HostController, CatchAllController],
    });
    const r = await get(`${booted.baseUrl}/_nestrix/`, BEARER);
    expect(r.text).toBe("host-catch-all");
    await waitFor(() =>
      logs.some((l) => l.includes("is shadowed by a host route")),
    );
    await get(`${booted.baseUrl}/_nestrix/api/v1/meta`, BEARER);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lines = logs.filter((l) => l.includes("shadowed"));
    expect(lines).toEqual([
      "Nestrix dashboard: /_nestrix is shadowed by a host route (a catch-all, or @nestjs/serve-static's fallback): a request under it was answered with status 200 without reaching the dashboard. Exclude /_nestrix from that route (for @nestjs/serve-static, its exclude option) or set ui.path to another path.",
    ]);
  });

  it.each(ADAPTERS)(
    "%s: a reachable dashboard logs nothing about shadowing",
    async (adapter) => {
      booted = await bootDashboardApp({ adapter, nestrix: ENABLED });
      await get(`${booted.baseUrl}/_nestrix/`, BEARER);
      await get(`${booted.baseUrl}/_nestrix/api/v1/meta`); // denied 404: still our handler
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        logs.filter(
          (l) => l.includes("shadowed") || l.includes("host middleware"),
        ),
      ).toEqual([]);
    },
  );

  it.each(ADAPTERS)(
    "%s: host middleware answering 401 is reported as such, not as shadowing",
    async (adapter) => {
      booted = await bootDashboardApp({
        adapter,
        nestrix: ENABLED,
        configure: (app) =>
          app.use((_req: unknown, res: unknown) => {
            const raw = ((res as { raw?: unknown }).raw ?? res) as {
              statusCode: number;
              end(): void;
            };
            raw.statusCode = 401;
            raw.end();
          }),
      });
      expect((await get(`${booted.baseUrl}/_nestrix/`, BEARER)).status).toBe(
        401,
      );
      await waitFor(() => logs.some((l) => l.includes("host middleware")));
      expect(
        logs.filter((l) => l.includes("shadowed by a host route")),
      ).toEqual([]);
    },
  );
});

describe("no HTTP adapter", () => {
  it("createApplicationContext: nothing registered, store detached, nothing logged, nothing thrown", async () => {
    @Module({ imports: [NestrixModule.forRoot(ENABLED)] })
    class Ctx {}
    const app = await NestFactory.createApplicationContext(Ctx, {
      logger: false,
    });
    expect(getStore()?.stats().attached ?? 0).toBe(0);
    expect(logs.filter((l) => l.startsWith("Nestrix dashboard"))).toEqual([]);
    expect([...getFailureCounts().keys()]).toEqual([]);
    await app.close();
  });
});
