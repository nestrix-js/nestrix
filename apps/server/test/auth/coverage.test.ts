// What the admin login covers: any controller under /api/v1 (as P5-03's query API will be),
// unknown paths, the guard behind the middleware, cross-site refusal, CORS, and the 503 mode
// without NESTRIX_ADMIN_PASSWORD. Ingest is never affected.
import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { Controller, Get, Header, Logger, Module, Post } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { startupMessages } from "../../src/auth/admin-auth.js";
import { UI_CSP } from "../../src/auth/http.js";
import { configureApp } from "../../src/bootstrap.js";
import type { ServerConfig } from "../../src/config.js";
import { INGEST_SINK } from "../../src/ingest/tokens.js";
import {
  fixture,
  auth as ingestAuth,
  PROTO,
  post,
  RecordingSink,
  startServer,
  type TestServer,
  testConfig,
} from "../ingest/helpers.js";
import {
  ADMIN_PW,
  corsHeaders,
  originOf,
  rawRequest,
  SESSION_SECRET,
  signedCookie,
} from "./helpers.js";

/** Stands in for the query API (P5-03), registered the way any feature module would be. */
@Controller("api/v1")
class ProbeController {
  @Get("probe")
  probe() {
    return { ok: true };
  }

  @Post("probe")
  change() {
    return { changed: true };
  }

  @Get("cors")
  @Header("access-control-allow-origin", "*")
  cors() {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

const authConfig = (): ServerConfig =>
  testConfig({
    NESTRIX_ADMIN_PASSWORD: ADMIN_PW,
    NESTRIX_SESSION_SECRET: SESSION_SECRET,
  });

async function start(
  config: ServerConfig,
  options: { configure?: boolean } = {},
): Promise<{ app: NestExpressApplication; baseUrl: string }> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(config), ProbeModule],
  })
    .overrideProvider(INGEST_SINK)
    .useValue(new RecordingSink())
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  if (options.configure !== false) configureApp(app);
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}

async function stop(app: NestExpressApplication | undefined): Promise<void> {
  if (!app) return;
  app.getHttpServer().closeAllConnections();
  await app.close();
}

describe("with an admin password", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  beforeAll(async () => {
    ({ app, baseUrl } = await start(authConfig()));
  });
  afterAll(() => stop(app));

  it("protects a controller under /api/v1 that another module registers", async () => {
    const anonymous = await fetch(`${baseUrl}/api/v1/probe`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({
      error: { code: "unauthorized" },
    });

    const signedIn = await fetch(`${baseUrl}/api/v1/probe`, {
      headers: { cookie: signedCookie() },
    });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toEqual({ ok: true });
    // The middleware's default headers reach responses written by other controllers.
    expect(signedIn.headers.get("content-security-policy")).toBe(UI_CSP);
    expect(signedIn.headers.get("cache-control")).toBe("no-store");
    expect(signedIn.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("protects every spelling Express routes to it, and unknown paths", async () => {
    for (const target of [
      "/api/v1/probe",
      "/API/V1/PROBE",
      "/api/v1/probe/",
      "/Api/v1/probe?x=1",
      "/api/v1/does-not-exist",
      "/api",
      "/api/",
      "/%61pi/v1/probe",
    ]) {
      const res = await rawRequest(baseUrl, "GET", target);
      expect(res.status, target).toBe(target.startsWith("/%61") ? 303 : 401);
    }
    for (const target of [
      "/",
      "/index.html",
      "/anything",
      "/login/../api/v1/probe",
      "/v1/traces/../api/v1/probe",
      "/v1/tracesx",
      "/login.cssx",
      "http://127.0.0.1/api/v1/probe",
    ]) {
      const res = await rawRequest(baseUrl, "GET", target);
      expect(res.status, target).toBe(303);
      expect(res.headers.location, target).toBe("/login");
    }
  });

  it("requires a same-origin Origin for state-changing methods, even with a session", async () => {
    const noOrigin = await rawRequest(baseUrl, "POST", "/api/v1/probe", {
      cookie: signedCookie(),
    });
    expect(noOrigin.status).toBe(403);
    const otherOrigin = await rawRequest(baseUrl, "POST", "/api/v1/probe", {
      cookie: signedCookie(),
      origin: "http://localhost:3000",
    });
    expect(otherOrigin.status).toBe(403);
    const sameOrigin = await rawRequest(baseUrl, "POST", "/api/v1/probe", {
      cookie: signedCookie(),
      origin: originOf(baseUrl),
    });
    expect(sameOrigin.status).toBe(201);
  });

  it("refuses Sec-Fetch-Site: cross-site on the UI, the API and the login, but not on ingest", async () => {
    const crossSite = {
      "sec-fetch-site": "cross-site",
      cookie: signedCookie(),
    };
    const ui = await rawRequest(baseUrl, "GET", "/", crossSite);
    expect(ui.status).toBe(403);
    const api = await rawRequest(baseUrl, "GET", "/api/v1/probe", crossSite);
    expect(api.status).toBe(403);
    expect(JSON.parse(api.body)).toMatchObject({
      error: { code: "forbidden" },
    });
    const login = await rawRequest(baseUrl, "GET", "/login", crossSite);
    expect(login.status).toBe(403);
    const mixed = await rawRequest(baseUrl, "GET", "/", {
      "sec-fetch-site": "same-origin, Cross-Site",
      cookie: signedCookie(),
    });
    expect(mixed.status).toBe(403);
    const sameOrigin = await rawRequest(baseUrl, "GET", "/", {
      "sec-fetch-site": "same-origin",
      cookie: signedCookie(),
    });
    expect(sameOrigin.status).toBe(200);

    const ingest = await post(`${baseUrl}/v1/traces`, fixture("traces.pb"), {
      ...ingestAuth(),
      "content-type": PROTO,
      "sec-fetch-site": "cross-site",
    });
    expect(ingest.status).toBe(200);
  });

  it("never emits Access-Control-* headers, preflight included", async () => {
    const origin = { origin: "http://evil.example" };
    const responses = [
      await rawRequest(baseUrl, "OPTIONS", "/api/v1/probe", {
        ...origin,
        "access-control-request-method": "GET",
      }),
      await rawRequest(baseUrl, "OPTIONS", "/api/v1/probe", {
        ...origin,
        cookie: signedCookie(),
        "access-control-request-method": "GET",
      }),
      await rawRequest(baseUrl, "GET", "/api/v1/probe", origin),
      await rawRequest(baseUrl, "GET", "/api/v1/probe", {
        ...origin,
        cookie: signedCookie(),
      }),
      await rawRequest(baseUrl, "GET", "/", origin),
      await rawRequest(baseUrl, "GET", "/", {
        ...origin,
        cookie: signedCookie(),
      }),
      await rawRequest(baseUrl, "GET", "/login", origin),
      await rawRequest(baseUrl, "POST", "/login", origin, "password=x"),
      await rawRequest(baseUrl, "POST", "/logout", origin),
    ];
    for (const res of responses) {
      expect(corsHeaders(res.headers)).toEqual([]);
    }
    // A preflight from a foreign Origin is refused outright, session or not: never a CORS answer.
    expect(responses[0]?.status).toBe(403);
    expect(responses[1]?.status).toBe(403);
  });

  it("strips a CORS header that a later controller sets itself", async () => {
    const res = await fetch(`${baseUrl}/api/v1/cors`, {
      headers: { cookie: signedCookie(), origin: "http://evil.example" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(corsHeaders(res.headers)).toEqual([]);
  });

  it("strips CORS headers even when Nest's own CORS is enabled", async () => {
    const config = authConfig();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config), ProbeModule],
    })
      .overrideProvider(INGEST_SINK)
      .useValue(new RecordingSink())
      .compile();
    const corsApp = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureApp(corsApp);
    corsApp.enableCors({ origin: true, credentials: true });
    await corsApp.listen(0, "127.0.0.1");
    try {
      const { port } = corsApp.getHttpServer().address() as AddressInfo;
      const url = `http://127.0.0.1:${port}`;
      const get = await rawRequest(url, "GET", "/api/v1/probe", {
        origin: "http://evil.example",
        cookie: signedCookie(),
      });
      expect(get.status).toBe(200);
      expect(corsHeaders(get.headers)).toEqual([]);
      const preflight = await rawRequest(url, "OPTIONS", "/api/v1/probe", {
        origin: "http://evil.example",
        "access-control-request-method": "GET",
      });
      expect(corsHeaders(preflight.headers)).toEqual([]);
    } finally {
      await stop(corsApp);
    }
  });
});

describe("the guard behind the middleware", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  beforeAll(async () => {
    // Built without configureApp: no middleware, so nothing is stamped.
    ({ app, baseUrl } = await start(authConfig(), { configure: false }));
  });
  afterAll(() => stop(app));

  it("refuses every controller, even with a valid session cookie", async () => {
    for (const path of ["/api/v1/probe", "/", "/login"]) {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { cookie: signedCookie() },
        redirect: "manual",
      });
      expect(res.status, path).toBe(401);
    }
    const ingest = await post(`${baseUrl}/v1/traces`, fixture("traces.pb"), {
      ...ingestAuth(),
      "content-type": PROTO,
    });
    expect(ingest.status).toBe(401);
  });
});

describe("without NESTRIX_ADMIN_PASSWORD", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer(testConfig());
  });
  afterAll(() => server?.close());

  it("answers 503 on the UI, the API and the login, with a message saying how to fix it", async () => {
    const ui = await fetch(`${server.baseUrl}/`, { redirect: "manual" });
    expect(ui.status).toBe(503);
    expect(ui.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await ui.text()).toContain("NESTRIX_ADMIN_PASSWORD is not set");

    const api = await fetch(`${server.baseUrl}/api/v1/meta`);
    expect(api.status).toBe(503);
    const body = (await api.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("unavailable");
    expect(body.error.message).toContain("NESTRIX_ADMIN_PASSWORD");

    const page = await fetch(`${server.baseUrl}/login`);
    expect(page.status).toBe(503);
    const login = await fetch(`${server.baseUrl}/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: originOf(server.baseUrl),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "password=whatever-at-all",
    });
    expect(login.status).toBe(503);
    expect(login.headers.get("set-cookie")).toBeNull();

    // A cookie signed with any key admits nothing.
    const cookie = await fetch(`${server.baseUrl}/`, {
      headers: { cookie: signedCookie() },
      redirect: "manual",
    });
    expect(cookie.status).toBe(503);
  });

  it("keeps ingest working", async () => {
    const res = await post(server.url, fixture("traces.pb"), {
      ...ingestAuth(),
      "content-type": PROTO,
    });
    expect(res.status).toBe(200);
    expect(server.sink.spans().length).toBeGreaterThan(0);
  });

  it("logs at start how to set it", async () => {
    expect(
      startupMessages({
        adminPassword: undefined,
        sessionSecretGenerated: true,
      }).warn[0],
    ).toMatch(
      /^NESTRIX_ADMIN_PASSWORD is not set: .*503.*at least 12 characters/,
    );
    expect(
      startupMessages({ adminPassword: ADMIN_PW, sessionSecretGenerated: true })
        .log[0],
    ).toContain("NESTRIX_SESSION_SECRET is not set");
    expect(
      startupMessages({
        adminPassword: ADMIN_PW,
        sessionSecretGenerated: false,
      }),
    ).toEqual({ warn: [], log: [] });

    const warn = vi.spyOn(Logger.prototype, "warn");
    try {
      const other = await startServer(testConfig());
      await other.close();
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).startsWith("NESTRIX_ADMIN_PASSWORD is not set"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
