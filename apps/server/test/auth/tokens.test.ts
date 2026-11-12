/**
 * API tokens (docs/backlog/phase-8.md P8-01) on the whole server against a real PostgreSQL:
 * create, list and revoke from a session; what a token reads and everything it is refused;
 * revocation at once; forged tokens counted toward the login limiter's global failure budget;
 * tokens never taken from a query string or cookie; no CORS; `last_used_at`; a failing store.
 */
import "reflect-metadata";
import { createHash } from "node:crypto";
import type {
  ApiToken,
  ApiTokenCreateResponse,
  ApiTokenListResponse,
} from "@nestrix-js/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdminAuth } from "../../src/auth/admin-auth.js";
import { ApiTokenStore } from "../../src/auth/api-tokens.js";
import { LoginRateLimiter } from "../../src/auth/login-rate-limit.js";
import { type AlertsServer, startAlertsServer } from "../alerts/helpers.js";
import { KEY } from "../ingest/helpers.js";
import {
  createTestDb,
  noDatabase,
  skipReason,
  type TestDb,
} from "../storage/helpers.js";
import { ADMIN_PW, corsHeaders, postLogin, rawRequest } from "./helpers.js";

const READ_ROUTES = [
  "/api/v1/meta",
  "/api/v1/traces",
  "/api/v1/traces?limit=5&status=error",
  "/api/v1/errors",
  "/api/v1/routes",
  "/api/v1/routes?windowMinutes=60",
  "/api/v1/classes",
  "/api/v1/map",
  "/api/v1/meta/",
  "/API/V1/TRACES",
];

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const wellFormedUnknown = () =>
  `nxt_${Buffer.alloc(32, 7).toString("base64url")}`;

describe.skipIf(noDatabase)(`API tokens ${skipReason}`, () => {
  let db: TestDb;
  let server: AlertsServer;
  let auth: AdminAuth;
  let store: ApiTokenStore;
  /** A token created in `beforeAll`, never revoked. */
  let token: string;
  let tokenId: string;

  const create = async (name: string): Promise<ApiTokenCreateResponse> => {
    const res = await server.call("POST", "/api/v1/tokens", { name });
    expect(res.status).toBe(201);
    return (await res.json()) as ApiTokenCreateResponse;
  };
  const read = (path: string, headers: Record<string, string>) =>
    fetch(`${server.baseUrl}${path}`, { headers, redirect: "manual" });
  const failures = () =>
    (auth.limiter as unknown as { failures: number[] }).failures.length;

  beforeAll(async () => {
    db = await createTestDb("api_tokens");
    server = await startAlertsServer(db.url);
    auth = server.app.get(AdminAuth);
    store = server.app.get(ApiTokenStore);
    const created = await create("ci reader");
    token = created.secret;
    tokenId = created.token.id;
  });

  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  beforeEach(() => {
    auth.limiter = new LoginRateLimiter();
  });

  describe("management (session only)", () => {
    it("creates a token, shows its secret once, and stores only its hash", async () => {
      const res = await server.call("POST", "/api/v1/tokens", {
        name: "  mcp on laptop  ",
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as ApiTokenCreateResponse;
      expect(body.secret).toMatch(/^nxt_[A-Za-z0-9_-]{43}$/);
      expect(body.token).toMatchObject({
        name: "mcp on laptop",
        prefix: body.secret.slice(0, 8),
        lastUsedAtUnixMs: null,
        revokedAtUnixMs: null,
      });
      expect(Object.keys(body.token).sort()).toEqual(
        [
          "createdAtUnixMs",
          "id",
          "lastUsedAtUnixMs",
          "name",
          "prefix",
          "revokedAtUnixMs",
        ].sort(),
      );
      const { rows } = await db.pool.query(
        "SELECT * FROM api_tokens WHERE id = $1",
        [body.token.id],
      );
      expect(rows[0].hash).toBe(sha256(body.secret));
      // Nothing in the row holds the secret.
      expect(JSON.stringify(rows[0])).not.toContain(body.secret.slice(8));
    });

    it("lists tokens without secrets or hashes, newest first", async () => {
      const a = await create("list a");
      const b = await create("list b");
      const res = await server.call("GET", "/api/v1/tokens");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(a.secret);
      expect(text).not.toContain(sha256(a.secret));
      expect(text).not.toContain(b.secret);
      expect(text).not.toContain("hash");
      const list = JSON.parse(text) as ApiTokenListResponse;
      const ids = list.tokens.map((t) => t.id);
      expect(ids.indexOf(b.token.id)).toBeLessThan(ids.indexOf(a.token.id));
    });

    it("revokes a token (204), again (204, first time kept), and 404 for an unknown id", async () => {
      const t = await create("to revoke");
      const first = await server.call("DELETE", `/api/v1/tokens/${t.token.id}`);
      expect(first.status).toBe(204);
      const listed = async () =>
        (
          (await (
            await server.call("GET", "/api/v1/tokens")
          ).json()) as ApiTokenListResponse
        ).tokens.find((x) => x.id === t.token.id) as ApiToken;
      const revokedAt = (await listed()).revokedAtUnixMs;
      expect(revokedAt).toEqual(expect.any(Number));
      expect(
        (await server.call("DELETE", `/api/v1/tokens/${t.token.id}`)).status,
      ).toBe(204);
      expect((await listed()).revokedAtUnixMs).toBe(revokedAt);
      expect(
        (await server.call("DELETE", "/api/v1/tokens/999999")).status,
      ).toBe(404);
      expect((await server.call("DELETE", "/api/v1/tokens/abc")).status).toBe(
        400,
      );
    });

    it.each([
      [{}, "name must be a string."],
      [{ name: "" }, "name must have 1 to 100 characters."],
      [{ name: "x".repeat(101) }, "name must have 1 to 100 characters."],
      [{ name: "a\u0007b" }, "name contains control characters."],
      [{ name: "ok", scope: "write" }, "Unknown field: scope."],
      [[], "The body must be a JSON object."],
    ])("refuses a bad body %j (400)", async (body, message) => {
      const res = await server.call("POST", "/api/v1/tokens", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: "bad_request", message },
      });
    });

    it("writes need a same-origin Origin even with a session (403)", async () => {
      for (const [method, path] of [
        ["POST", "/api/v1/tokens"],
        ["DELETE", `/api/v1/tokens/${tokenId}`],
      ] as const) {
        const missing = await rawRequest(
          server.baseUrl,
          method,
          path,
          {
            cookie: server.cookie,
            "content-type": "application/json",
          },
          method === "POST" ? '{"name":"x"}' : undefined,
        );
        expect(missing.status).toBe(403);
        const other = await server.call(
          method,
          path,
          method === "POST" ? { name: "x" } : undefined,
          {
            origin: "http://evil.example",
          },
        );
        expect(other.status).toBe(403);
      }
      // The token still works: the refused DELETE did nothing.
      expect((await read("/api/v1/meta", bearer(token))).status).toBe(200);
    });

    it.each([
      ["GET", "/api/v1/tokens"],
      ["POST", "/api/v1/tokens"],
      ["DELETE", "/api/v1/tokens/1"],
    ])("%s %s answers 401 when signed out", async (method, path) => {
      const res = await fetch(`${server.baseUrl}${path}`, {
        method,
        headers: { origin: server.origin, "content-type": "application/json" },
        ...(method === "POST" ? { body: '{"name":"x"}' } : {}),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("what a token reads", () => {
    it.each(READ_ROUTES)("GET %s answers 200 with a token", async (path) => {
      const res = await read(path, bearer(token));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(corsHeaders(res.headers)).toEqual([]);
    });

    it("GET /api/v1/trace passes authentication (404 for an unknown trace, 400 without id)", async () => {
      const unknown = await read(
        `/api/v1/trace?id=${"ab".repeat(16)}`,
        bearer(token),
      );
      expect(unknown.status).toBe(404);
      expect((await read("/api/v1/trace", bearer(token))).status).toBe(400);
    });

    it("HEAD on a read route answers 200", async () => {
      const res = await rawRequest(
        server.baseUrl,
        "HEAD",
        "/api/v1/meta",
        bearer(token),
      );
      expect(res.status).toBe(200);
    });

    it("accepts the scheme in any case", async () => {
      const res = await read("/api/v1/meta", {
        authorization: `bearer ${token}`,
      });
      expect(res.status).toBe(200);
    });

    it("gives the same answer as a session", async () => {
      const withToken = await (
        await read("/api/v1/meta", bearer(token))
      ).json();
      const withSession = await (
        await server.call("GET", "/api/v1/meta")
      ).json();
      expect(Object.keys(withToken).sort()).toEqual(
        Object.keys(withSession).sort(),
      );
      expect(withToken.mode).toBe("standalone");
      expect(withToken.services).toEqual(withSession.services);
    });
  });

  describe("what a token is refused", () => {
    const refusedWithToken: [string, string, unknown?][] = [
      ["GET", "/"],
      ["GET", "/index.html"],
      ["GET", "/assets/app.js"],
      ["GET", "/login"],
      ["GET", "/login.css"],
      ["POST", "/login", "password=x"],
      ["POST", "/logout"],
      ["GET", "/api/v1/tokens"],
      ["POST", "/api/v1/tokens", { name: "escalate" }],
      ["DELETE", "/api/v1/tokens/1"],
      ["GET", "/api/v1/alerts"],
      ["GET", "/api/v1/alerts/events"],
      ["GET", "/api/v1/alerts/1"],
      ["POST", "/api/v1/alerts", {}],
      ["PATCH", "/api/v1/alerts/1", {}],
      ["DELETE", "/api/v1/alerts/1"],
      ["POST", "/api/v1/alerts/1/test"],
      ["GET", "/api/v1/slos"],
      ["GET", "/api/v1/slos/1"],
      ["POST", "/api/v1/slos", {}],
      ["PATCH", "/api/v1/slos/1", {}],
      ["DELETE", "/api/v1/slos/1"],
      ["POST", "/api/v1/profiles", { durationSeconds: 1 }],
      ["GET", "/api/v1/profiles"],
      ["POST", "/api/v1/meta"],
      ["PUT", "/api/v1/traces"],
      ["DELETE", "/api/v1/traces"],
      ["OPTIONS", "/api/v1/meta"],
      ["GET", "/api/v1/unknown"],
      ["GET", "/api/v1/meta/extra"],
      ["GET", "/api/v1//meta"],
      ["GET", "/api/v2/meta"],
      ["GET", "/api"],
      ["GET", "/somewhere"],
    ];

    it.each(refusedWithToken)(
      "%s %s answers 401 with a valid token, a session and a same-origin Origin",
      async (method, path, body) => {
        const before = failures();
        // The session cookie and Origin are there too: a token request is judged by the token alone.
        const res = await rawRequest(
          server.baseUrl,
          method,
          path,
          {
            ...bearer(token),
            cookie: server.cookie,
            origin: server.origin,
            ...(body === undefined
              ? {}
              : {
                  "content-type":
                    typeof body === "string"
                      ? "application/x-www-form-urlencoded"
                      : "application/json",
                }),
          },
          body === undefined
            ? undefined
            : typeof body === "string"
              ? body
              : JSON.stringify(body),
        );
        expect(res.status).toBe(401);
        expect(res.headers["www-authenticate"]).toBe(
          'Bearer realm="nestrix", error="invalid_token"',
        );
        expect(corsHeaders(res.headers)).toEqual([]);
        // Refusing a route is not a failed guess: nothing is counted.
        expect(failures()).toBe(before);
      },
    );

    it("a token cannot create a token, and nothing was created by the attempts above", async () => {
      const { rows } = await db.pool.query(
        "SELECT count(*)::int AS n FROM api_tokens WHERE name = 'escalate'",
      );
      expect(rows[0].n).toBe(0);
    });

    it("POST /v1/traces with an API token answers 401 (an API token is not an ingest key)", async () => {
      const res = await fetch(`${server.baseUrl}/v1/traces`, {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: '{"resourceSpans":[]}',
      });
      expect(res.status).toBe(401);
      const viaKeyHeader = await fetch(`${server.baseUrl}/v1/traces`, {
        method: "POST",
        headers: { "x-nestrix-key": token, "content-type": "application/json" },
        body: '{"resourceSpans":[]}',
      });
      expect(viaKeyHeader.status).toBe(401);
    });

    it("an ingest key does not read the query API (401)", async () => {
      expect((await read("/api/v1/meta", bearer(KEY))).status).toBe(401);
      expect(
        (await read("/api/v1/meta", { "x-nestrix-key": KEY })).status,
      ).toBe(401);
    });

    it("is not taken from a query string or a cookie", async () => {
      for (const path of [
        `/api/v1/meta?access_token=${token}`,
        `/api/v1/meta?token=${token}`,
        `/api/v1/meta?authorization=Bearer%20${token}`,
      ]) {
        expect((await read(path, {})).status).toBe(401);
      }
      for (const cookie of [
        `authorization=Bearer ${token}`,
        `token=${token}`,
        `nestrix_token=${token}`,
        `${server.cookie.split("=", 1)[0]}=${token}`,
      ]) {
        expect((await read("/api/v1/meta", { cookie })).status).toBe(401);
      }
      // Other headers are not read either.
      expect((await read("/api/v1/meta", { "x-api-key": token })).status).toBe(
        401,
      );
      expect(
        (await read("/api/v1/meta", { authorization: `Token ${token}` }))
          .status,
      ).toBe(401);
      expect(
        (await read("/api/v1/meta", { authorization: token })).status,
      ).toBe(401);
    });

    it("two Authorization headers never pass, even when one is valid", async () => {
      // Observed on Node 26: its HTTP server answers 400 to a repeated Authorization header
      // before the app sees the request. The middleware also refuses it (`malformed`, unit test).
      for (const second of [`Bearer ${token}`, "Basic eDp5"]) {
        const res = await rawRequest(server.baseUrl, "GET", "/api/v1/meta", [
          "authorization",
          `Bearer ${token}`,
          "authorization",
          second,
        ]);
        expect([400, 401]).toContain(res.status);
      }
    });

    it("cross-site browser requests are refused (403) before the token is looked at", async () => {
      const res = await rawRequest(server.baseUrl, "GET", "/api/v1/meta", {
        ...bearer(token),
        "sec-fetch-site": "cross-site",
      });
      expect(res.status).toBe(403);
    });
  });

  describe("forged, wrong and revoked tokens", () => {
    it.each([
      ["unknown but well formed", wellFormedUnknown()],
      ["too short", "nxt_abc"],
      ["too long", `${"nxt_"}${"A".repeat(44)}`],
      ["bad characters", `nxt_${"A".repeat(42)}=`],
      ["empty after the prefix", "nxt_"],
    ])(
      "refuses a token that is %s (401) and counts it",
      async (_label, value) => {
        const before = failures();
        const res = await read("/api/v1/meta", bearer(value));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({
          error: {
            code: "unauthorized",
            message: "Invalid or revoked API token.",
          },
        });
        expect(failures()).toBe(before + 1);
      },
    );

    it("refuses the real token with one character changed", async () => {
      const last = token.at(-1) === "A" ? "B" : "A";
      const res = await read(
        "/api/v1/meta",
        bearer(`${token.slice(0, -1)}${last}`),
      );
      expect(res.status).toBe(401);
    });

    it("a revoked token is refused with the next request", async () => {
      const t = await create("revoked at once");
      expect((await read("/api/v1/traces", bearer(t.secret))).status).toBe(200);
      expect(
        (await server.call("DELETE", `/api/v1/tokens/${t.token.id}`)).status,
      ).toBe(204);
      const res = await read("/api/v1/traces", bearer(t.secret));
      expect(res.status).toBe(401);
      // The other token is unaffected.
      expect((await read("/api/v1/traces", bearer(token))).status).toBe(200);
    });

    it("failures share the login's global budget: once spent, tokens and logins answer 429", async () => {
      let now = 1_000_000;
      auth.limiter = new LoginRateLimiter(5, 60_000, () => now, 10_000, 3);
      for (let i = 0; i < 3; i++) {
        expect(
          (await read("/api/v1/meta", bearer(wellFormedUnknown()))).status,
        ).toBe(401);
      }
      const limited = await read("/api/v1/meta", bearer(token));
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      expect((await limited.json()).error.code).toBe("too_many_requests");
      // The password login draws on the same budget.
      expect((await postLogin(server.baseUrl, ADMIN_PW)).status).toBe(429);
      // A signed-in session is not affected.
      expect((await server.call("GET", "/api/v1/meta")).status).toBe(200);
      now += 60_000;
      expect((await read("/api/v1/meta", bearer(token))).status).toBe(200);
    });

    it("wrong passwords spend the budget for tokens too", async () => {
      const now = 1_000_000;
      auth.limiter = new LoginRateLimiter(5, 60_000, () => now, 10_000, 2);
      expect((await postLogin(server.baseUrl, "wrong-password-1")).status).toBe(
        401,
      );
      expect((await postLogin(server.baseUrl, "wrong-password-2")).status).toBe(
        401,
      );
      expect((await read("/api/v1/meta", bearer(token))).status).toBe(429);
    });
  });

  describe("CORS", () => {
    it("never answers with Access-Control-* headers, preflight or not", async () => {
      const preflight = await rawRequest(
        server.baseUrl,
        "OPTIONS",
        "/api/v1/meta",
        {
          origin: "http://evil.example",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      );
      expect(preflight.status).toBe(403);
      expect(corsHeaders(preflight.headers)).toEqual([]);
      const get = await read("/api/v1/meta", {
        ...bearer(token),
        origin: "http://evil.example",
      });
      expect(get.status).toBe(200);
      expect(corsHeaders(get.headers)).toEqual([]);
      const refused = await read("/api/v1/meta", {
        ...bearer(wellFormedUnknown()),
        origin: "http://evil.example",
      });
      expect(corsHeaders(refused.headers)).toEqual([]);
    });
  });

  describe("last_used_at", () => {
    it("is set on first use and written at most once a minute", async () => {
      const t = await create("usage");
      const lastUsed = async () =>
        (
          await db.pool.query(
            "SELECT last_used_at FROM api_tokens WHERE id = $1",
            [t.token.id],
          )
        ).rows[0].last_used_at as Date | null;
      expect(await lastUsed()).toBeNull();
      let now = Date.UTC(2026, 10, 12, 10, 0, 0);
      store.nowMs = () => now;
      try {
        expect((await read("/api/v1/meta", bearer(t.secret))).status).toBe(200);
        await store.lastUsedWrite;
        expect((await lastUsed())?.getTime()).toBe(now);

        now += 30_000;
        expect((await read("/api/v1/meta", bearer(t.secret))).status).toBe(200);
        await store.lastUsedWrite;
        expect((await lastUsed())?.getTime()).toBe(now - 30_000);

        now += 31_000;
        expect((await read("/api/v1/meta", bearer(t.secret))).status).toBe(200);
        await store.lastUsedWrite;
        expect((await lastUsed())?.getTime()).toBe(now);

        const listed = (
          (await (
            await server.call("GET", "/api/v1/tokens")
          ).json()) as ApiTokenListResponse
        ).tokens.find((x) => x.id === t.token.id);
        expect(listed?.lastUsedAtUnixMs).toBe(now);
      } finally {
        store.nowMs = () => Date.now();
      }
    });
  });

  describe("a failing token store (fault injection)", () => {
    it("answers 503 and counts nothing when the lookup rejects or throws", async () => {
      try {
        auth.useTokenVerifier({
          verify: () => Promise.reject(new Error("database down")),
        });
        const before = failures();
        const rejected = await read("/api/v1/meta", bearer(token));
        expect(rejected.status).toBe(503);
        expect((await rejected.json()).error.code).toBe("unavailable");
        auth.useTokenVerifier({
          verify: () => {
            throw new Error("synchronous failure");
          },
        });
        expect((await read("/api/v1/meta", bearer(token))).status).toBe(503);
        expect(failures()).toBe(before);
        // The session path is unaffected.
        expect((await server.call("GET", "/api/v1/meta")).status).toBe(200);
      } finally {
        auth.useTokenVerifier(store);
      }
      expect((await read("/api/v1/meta", bearer(token))).status).toBe(200);
    });

    it("answers 503 when the database is unreachable", async () => {
      const original = (store as unknown as { pool: unknown }).pool;
      (store as unknown as { pool: unknown }).pool = {
        query: () => Promise.reject(new Error("connection refused")),
      };
      try {
        expect((await read("/api/v1/meta", bearer(token))).status).toBe(503);
      } finally {
        (store as unknown as { pool: unknown }).pool = original;
      }
    });
  });
});
