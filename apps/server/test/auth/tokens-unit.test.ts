/**
 * API tokens without a database (P8-01): token format and hashing, the `Authorization` parser,
 * the guards' treatment of the `token` stamp, the middleware's stamp, and the receiver-only app
 * (no token store: every token refused) and an app without an admin password (503).
 */
import "reflect-metadata";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type ExecutionContext, RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AlertsController } from "../../src/alerts/alerts.controller.js";
import {
  AdminAuth,
  AUTH_STAMP,
  type AuthStamp,
  bearerCredentialOf,
  stampOf,
  TOKEN_READ_ROUTE,
  tokenIdOf,
} from "../../src/auth/admin-auth.js";
import {
  generateApiToken,
  hashApiToken,
  isApiTokenShape,
  validateTokenCreate,
} from "../../src/auth/api-tokens.js";
import { AuthController } from "../../src/auth/auth.controller.js";
import { AdminAuthGuard } from "../../src/auth/auth.guard.js";
import {
  ReadQueryGuard,
  SessionQueryGuard,
} from "../../src/auth/query-guard.js";
import { TokensController } from "../../src/auth/tokens.controller.js";
import { IngestController } from "../../src/ingest/ingest.controller.js";
import { QueryController } from "../../src/query/query.controller.js";
import { SlosController } from "../../src/slos/slos.controller.js";
import { startServer, type TestServer, testConfig } from "../ingest/helpers.js";
import { ADMIN_PW, SESSION_SECRET, startAuthServer } from "./helpers.js";

const req = (rawHeaders: string[]) =>
  ({ rawHeaders, headers: {} }) as unknown as IncomingMessage;

function context(
  stamp: AuthStamp | undefined,
  method: string,
  target: unknown,
): ExecutionContext {
  const request: Record<string | symbol, unknown> = { method };
  if (stamp !== undefined) request[AUTH_STAMP] = stamp;
  return {
    getType: () => "http",
    getClass: () => target,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const allows = (
  guard: { canActivate(c: ExecutionContext): boolean },
  c: ExecutionContext,
) => {
  try {
    return guard.canActivate(c);
  } catch {
    return false;
  }
};

describe("token format", () => {
  it("is nxt_ and 43 base64url characters, random each time", () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a).toMatch(/^nxt_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(isApiTokenShape(a)).toBe(true);
    expect(Buffer.from(a.slice(4), "base64url")).toHaveLength(32);
  });

  it("hashes to hex SHA-256", () => {
    expect(hashApiToken("nxt_x")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiToken("nxt_x")).not.toBe(hashApiToken("nxt_y"));
  });

  it.each([
    "",
    "nxt_",
    `NXT_${"a".repeat(43)}`,
    `nxt_${"a".repeat(42)}`,
    `nxt_${"a".repeat(44)}`,
    `nxt_${"a".repeat(42)}+`,
    7,
    null,
  ])("refuses %j as a token", (value) =>
    expect(isApiTokenShape(value)).toBe(false),
  );

  it("validates create bodies", () => {
    expect(validateTokenCreate({ name: " x " })).toEqual({
      ok: true,
      name: "x",
    });
    expect(validateTokenCreate({ name: "\u{1F600}" }).ok).toBe(true);
    expect(validateTokenCreate({ name: "\uD800" }).ok).toBe(false);
    expect(validateTokenCreate(null).ok).toBe(false);
    expect(validateTokenCreate("name").ok).toBe(false);
  });
});

describe("Authorization parsing", () => {
  const token = generateApiToken();
  it.each([
    [[], { kind: "none" }],
    [["Authorization", "Basic dXNlcjpwYXNz"], { kind: "none" }],
    [["Authorization", "Bearer some-proxy-jwt"], { kind: "none" }],
    [["authorization", `Bearer ${token}`], { kind: "token", value: token }],
    [["AUTHORIZATION", `BEARER   ${token}  `], { kind: "token", value: token }],
    [
      ["Authorization", "Bearer nxt_short"],
      { kind: "token", value: "nxt_short" },
    ],
    [
      ["Authorization", `Bearer ${token}`, "Authorization", "Basic eA=="],
      { kind: "malformed" },
    ],
    [
      ["Authorization", "Basic eA==", "Authorization", `Bearer ${token}`],
      { kind: "malformed" },
    ],
    [["Authorization", `Bearer ${token} extra`], { kind: "none" }],
    [["X-Authorization", `Bearer ${token}`], { kind: "none" }],
  ])("%j → %j", (raw, expected) => {
    expect(bearerCredentialOf(req(raw as string[]))).toEqual(expected);
  });
});

describe("read routes open to tokens", () => {
  it.each([
    "/api/v1/meta",
    "/api/v1/traces",
    "/api/v1/trace",
    "/api/v1/errors",
    "/api/v1/routes",
    "/api/v1/classes",
    "/api/v1/map",
    "/api/v1/map/",
    "/Api/V1/Meta",
    "/api/v1/traces/timeline",
    "/api/v1/errors/groups",
    "/api/v1/routes/histogram",
    "/api/v1/routes/compare",
    "/api/v1/routes/explain",
    "/api/v1/queries",
    "/api/v1/dependencies",
  ])("%s is a read route", (path) =>
    expect(TOKEN_READ_ROUTE.test(path)).toBe(true),
  );

  it.each([
    "/api/v1/tokens",
    "/api/v1/alerts",
    "/api/v1/slos",
    "/api/v1/profiles",
    "/api/v1/meta/x",
    "/api/v1/dependencies/x",
    "/api/v1/traces/other",
    "/api/v1/errors/groups/x",
    "/api/v1/metax",
    "/api/v1",
    "/v1/traces",
    "/",
    "/login",
  ])("%s is not", (path) => expect(TOKEN_READ_ROUTE.test(path)).toBe(false));
});

describe("every QueryController read route is open to tokens", () => {
  const proto = QueryController.prototype as unknown as Record<string, unknown>;
  const handlers = Object.getOwnPropertyNames(proto).filter(
    (name) => name !== "constructor" && typeof proto[name] === "function",
  );
  const routes = handlers.map((name) => ({
    method: Reflect.getMetadata(METHOD_METADATA, proto[name] as object) as
      | RequestMethod
      | undefined,
    path: Reflect.getMetadata(PATH_METADATA, proto[name] as object) as
      | string
      | undefined,
  }));

  it("finds the controller's routes, all GET", () => {
    expect(routes.length).toBeGreaterThanOrEqual(13);
    expect(routes.every((r) => r.method === RequestMethod.GET)).toBe(true);
  });

  it("a token reads each @Get route (a new query route must be added to TOKEN_READ_ROUTE)", () => {
    for (const r of routes) {
      expect(
        TOKEN_READ_ROUTE.test(`/api/v1/${r.path}`),
        `/api/v1/${r.path}`,
      ).toBe(true);
    }
  });
});

describe("guards and the token stamp", () => {
  const global = new AdminAuthGuard();
  it("the global guard lets a token reach only QueryController, only for GET and HEAD", () => {
    expect(allows(global, context("token", "GET", QueryController))).toBe(true);
    expect(allows(global, context("token", "HEAD", QueryController))).toBe(
      true,
    );
    expect(allows(global, context("token", "POST", QueryController))).toBe(
      false,
    );
    for (const target of [
      TokensController,
      AlertsController,
      SlosController,
      IngestController,
      AuthController,
      class Other {},
    ]) {
      expect(allows(global, context("token", "GET", target))).toBe(false);
    }
    expect(allows(global, context(undefined, "GET", QueryController))).toBe(
      false,
    );
  });

  it("the admin APIs' guard refuses tokens; the query guard accepts them for reads", () => {
    expect(
      allows(
        new SessionQueryGuard(),
        context("token", "GET", TokensController),
      ),
    ).toBe(false);
    expect(
      allows(
        new SessionQueryGuard(),
        context("session", "GET", TokensController),
      ),
    ).toBe(true);
    const read = new ReadQueryGuard();
    expect(allows(read, context("token", "GET", QueryController))).toBe(true);
    expect(allows(read, context("token", "DELETE", QueryController))).toBe(
      false,
    );
    expect(allows(read, context("session", "GET", QueryController))).toBe(true);
    expect(allows(read, context("ingest", "GET", QueryController))).toBe(false);
    expect(allows(read, context(undefined, "GET", QueryController))).toBe(
      false,
    );
  });
});

describe("the middleware's token stamp", () => {
  it("stamps `token` and the token id, and passes the request on", async () => {
    const config = testConfig({
      NESTRIX_ADMIN_PASSWORD: ADMIN_PW,
      NESTRIX_SESSION_SECRET: SESSION_SECRET,
    });
    const auth = new AdminAuth(config);
    const token = generateApiToken();
    auth.useTokenVerifier({
      verify: async (t) => (t === token ? { id: "42" } : undefined),
    });
    const request = {
      method: "GET",
      url: "/api/v1/meta",
      headers: { authorization: `Bearer ${token}` },
      rawHeaders: ["Authorization", `Bearer ${token}`],
      socket: {},
    } as unknown as IncomingMessage;
    const headers = new Map<string, unknown>();
    const response = {
      setHeader: (n: string, v: unknown) => headers.set(n, v),
      getHeaderNames: () => [...headers.keys()],
      removeHeader: (n: string) => headers.delete(n),
      writeHead: () => response,
    } as unknown as ServerResponse;
    const passed = await new Promise<boolean>((resolve) => {
      auth.middleware()(request, response, () => resolve(true));
      setTimeout(() => resolve(false), 1000);
    });
    expect(passed).toBe(true);
    expect(stampOf(request)).toBe("token");
    expect(tokenIdOf(request)).toBe("42");
  });

  it("a `next` that throws after the async lookup leaves no unhandled rejection (fault injection)", async () => {
    const auth = new AdminAuth(
      testConfig({
        NESTRIX_ADMIN_PASSWORD: ADMIN_PW,
        NESTRIX_SESSION_SECRET: SESSION_SECRET,
      }),
    );
    const token = generateApiToken();
    auth.useTokenVerifier({ verify: async () => ({ id: "1" }) });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const headers = new Map<string, unknown>();
      const response = {
        setHeader: (n: string, v: unknown) => headers.set(n, v),
        getHeaderNames: () => [...headers.keys()],
        removeHeader: (n: string) => headers.delete(n),
        writeHead: () => response,
        end: () => undefined,
      } as unknown as ServerResponse;
      let calls = 0;
      auth.middleware()(
        {
          method: "GET",
          url: "/api/v1/meta",
          headers: {},
          rawHeaders: ["Authorization", `Bearer ${token}`],
          socket: {},
        } as unknown as IncomingMessage,
        response,
        () => {
          calls++;
          throw new Error("next failed");
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Called once to pass on, once with the error; both threw, and nothing escaped.
      expect(calls).toBe(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("apps without a token store or without an admin password", () => {
  let receiverOnly: TestServer;
  let noPassword: TestServer;
  const token = generateApiToken();

  beforeAll(async () => {
    noPassword = await startServer(testConfig());
    receiverOnly = await startAuthServer();
  });
  afterAll(async () => {
    await receiverOnly?.close();
    await noPassword?.close();
  });

  it("refuses every token where no store is registered (401)", async () => {
    const res = await fetch(`${receiverOnly.baseUrl}/api/v1/meta`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("answers 503 to tokens while the admin login is not configured", async () => {
    const res = await fetch(`${noPassword.baseUrl}/api/v1/meta`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("unavailable");
  });
});
