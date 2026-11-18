/**
 * Users, roles and single sign-on end to end (issue #34, D-104), against PostgreSQL and a fake
 * identity provider (fake-idp.ts): the sign-in flow and every way it is refused, what a viewer may
 * and may not do, a role change or a removal reaching open sessions, the audit log, the
 * break-glass password, and faults in the stores.
 */
import "reflect-metadata";
import type {
  ApiTokenCreateResponse,
  AuditListResponse,
  MetaResponse,
} from "@nestrix-js/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdminAuth } from "../../src/auth/admin-auth.js";
import { AuditLog, PostgresAuditStore } from "../../src/auth/audit.js";
import { LoginRateLimiter } from "../../src/auth/login-rate-limit.js";
import { OidcClient } from "../../src/auth/oidc.js";
import { type AlertsServer, startAlertsServer } from "../alerts/helpers.js";
import {
  createTestDb,
  noDatabase,
  skipReason,
  type TestDb,
} from "../storage/helpers.js";
import {
  ADMIN_GROUP,
  CLIENT_ID,
  CLIENT_SECRET,
  type FakeIdp,
  oidcEnv,
  REDIRECT_URL,
  rsaKey,
  signIn,
  startFakeIdp,
  VIEWER_GROUP,
} from "./fake-idp.js";
import {
  ADMIN_PW,
  corsHeaders,
  postLogin,
  rawRequest,
  signedCookie,
} from "./helpers.js";

/** A well-formed error group (`groupKeyOf("Error", "boom", undefined)`) in a named service. */
const TRIAGE_BODY = {
  key: JSON.stringify(["Error", "boom", null]),
  service: "checkout",
};

describe.skipIf(noDatabase)(`OIDC sign-in and roles ${skipReason}`, () => {
  let db: TestDb;
  let idp: FakeIdp;
  let server: AlertsServer;
  let auth: AdminAuth;

  /** A request with `cookie` (and a same-origin `Origin`). */
  const as = (
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> => server.call(method, path, body, { cookie });

  const meta = async (cookie: string) => {
    const res = await as(cookie, "GET", "/api/v1/meta");
    return { status: res.status, body: (await res.json()) as MetaResponse };
  };

  const auditEntries = async () => {
    const res = await server.call("GET", "/api/v1/audit?limit=200");
    expect(res.status).toBe(200);
    return ((await res.json()) as AuditListResponse).entries;
  };

  async function signInAs(
    claims: Record<string, unknown>,
  ): Promise<{ session: string; callback: Response }> {
    idp.claims = claims;
    const result = await signIn(server.baseUrl);
    if (result.session === undefined)
      throw new Error(`sign-in refused: ${result.callback.status}`);
    return { session: result.session, callback: result.callback };
  }

  beforeAll(async () => {
    db = await createTestDb("oidc_flow");
    idp = await startFakeIdp();
    server = await startAlertsServer(
      db.url,
      oidcEnv(idp, { NESTRIX_WEBHOOK_ALLOWED_HOSTS: "127.0.0.1" }),
    );
    auth = server.app.get(AdminAuth);
  });
  afterAll(async () => {
    await server?.close();
    await idp?.close();
    await db?.drop();
  });
  beforeEach(() => {
    auth.limiter = new LoginRateLimiter(1000);
    idp.claims = {};
    idp.tamper = undefined;
    idp.signingKey = undefined;
    idp.down = undefined;
  });

  describe("the sign-in flow", () => {
    it("offers single sign-on and the break-glass password on the login page", async () => {
      const res = await fetch(`${server.baseUrl}/login`);
      const html = await res.text();
      expect(html).toContain('<a class="button" href="/login/oidc">');
      expect(html).toContain("Break-glass admin password");
      expect(html).not.toMatch(/<script/i);
    });

    it("starts with a signed pending cookie and S256 PKCE, and ends with a strict user session", async () => {
      idp.claims = { sub: "flow-1" };
      const r = await signIn(server.baseUrl);
      expect(r.start.status).toBe(303);
      const location = new URL(r.start.headers.get("location") ?? "");
      expect(location.origin).toBe(idp.issuer);
      const auth0 = idp.authorizations.at(-1);
      expect(auth0?.params.get("code_challenge_method")).toBe("S256");
      expect(auth0?.params.get("client_id")).toBe(CLIENT_ID);
      expect(auth0?.params.get("redirect_uri")).toBe(REDIRECT_URL);
      expect(auth0?.params.get("scope")).toBe("openid email profile");
      expect(auth0?.params.get("state")).toMatch(/^[\w-]{43}$/);
      expect(auth0?.params.get("nonce")).toMatch(/^[\w-]{43}$/);
      const pendingLine =
        r.start.headers
          .getSetCookie()
          .find((c) => c.startsWith("nestrix_oidc_")) ?? "";
      expect(pendingLine).toContain("; Path=/login/oidc");
      expect(pendingLine).toContain("; Max-Age=600");
      expect(pendingLine).toContain("; HttpOnly");
      expect(pendingLine).toContain("; SameSite=Lax");
      // Nothing secret goes to the browser: the verifier is only in the signed cookie.
      expect(location.search).not.toContain(CLIENT_SECRET);

      expect(r.callback.status).toBe(200);
      const lines = r.callback.headers.getSetCookie();
      const session = lines.find((c) => c.startsWith("nestrix_admin_")) ?? "";
      expect(session).toMatch(/=v2\.\d+\.\d+\.[\w-]{22}\.\d+\.[\w-]{43};/);
      expect(session).toContain("; Max-Age=3600");
      expect(session).toContain("; HttpOnly");
      expect(session).toContain("; SameSite=Strict");
      const cleared = lines.find((c) => c.startsWith("nestrix_oidc_")) ?? "";
      expect(cleared).toContain("Max-Age=0");
      expect(await r.callback.text()).toContain(
        '<meta http-equiv="refresh" content="0;url=/">',
      );
      expect(corsHeaders(r.callback.headers)).toEqual([]);

      // The code was exchanged with the client's credentials and the PKCE verifier.
      const exchange = idp.tokenRequests.at(-1);
      expect(exchange?.form.get("code")).toBe(r.code);
      expect(exchange?.form.get("code_verifier")).toMatch(/^[\w-]{43}$/);
      expect(exchange?.form.has("client_secret")).toBe(false);
      expect(String(exchange?.headers.authorization)).toMatch(/^Basic /);

      const page = await fetch(`${server.baseUrl}/`, {
        headers: { cookie: r.session ?? "" },
        redirect: "manual",
      });
      expect(page.status).toBe(200);
    });

    it("accepts the provider's cross-site redirect to the callback, and nothing else cross-site", async () => {
      const res = await rawRequest(
        server.baseUrl,
        "GET",
        "/login/oidc/callback?code=x&state=y",
        { "sec-fetch-site": "cross-site" },
      );
      // Past the cross-site refusal; refused for the missing pending cookie instead.
      expect(res.status).toBe(401);
      const other = await rawRequest(server.baseUrl, "GET", "/login/oidc", {
        "sec-fetch-site": "cross-site",
      });
      expect(other.status).toBe(403);
    });

    it.each([
      [
        "a state that does not match",
        {
          callbackQuery: (q: URLSearchParams) => q.set("state", "x".repeat(43)),
        },
        "state_mismatch",
      ],
      ["no pending cookie", { pending: () => "" }, "state_mismatch"],
      [
        "no state",
        { callbackQuery: (q: URLSearchParams) => q.delete("state") },
        "state_missing",
      ],
      [
        "a pending cookie signed by someone else",
        {
          pending: (c: string) =>
            c.replace(/\.[\w-]{43}$/, `.${"A".repeat(43)}`),
        },
        "state_mismatch",
      ],
      [
        "an error from the provider",
        {
          callbackQuery: (q: URLSearchParams) =>
            q.set("error", "access_denied"),
        },
        "idp_error",
      ],
      [
        "no code",
        { callbackQuery: (q: URLSearchParams) => q.delete("code") },
        "code_missing",
      ],
      [
        "two codes",
        { callbackQuery: (q: URLSearchParams) => q.append("code", "other") },
        "code_missing",
      ],
    ])("refuses %s (401, no session, audited)", async (_name, opts, detail) => {
      const r = await signIn(server.baseUrl, opts);
      expect(r.callback.status).toBe(401);
      expect(r.session).toBeUndefined();
      expect(await r.callback.text()).toContain(
        "Single sign-on did not complete",
      );
      const entry = (await auditEntries()).find(
        (e) => e.action === "sign_in_failed",
      );
      expect(entry).toMatchObject({ outcome: "failed", detail });
    });

    it.each([
      [
        "id_token_nonce",
        (t: { payload: Record<string, unknown> }) => {
          t.payload.nonce = "x";
        },
      ],
      [
        "id_token_aud",
        (t: { payload: Record<string, unknown> }) => {
          t.payload.aud = "someone-else";
        },
      ],
      [
        "id_token_iss",
        (t: { payload: Record<string, unknown> }) => {
          t.payload.iss = "https://evil.example";
        },
      ],
      [
        "id_token_exp",
        (t: { payload: Record<string, unknown> }) => {
          t.payload.exp = 1000;
        },
      ],
      [
        "id_token_alg",
        (t: { header: Record<string, unknown> }) => {
          t.header.alg = "HS256";
        },
      ],
    ])("refuses an ID token that fails %s", async (detail, tamper) => {
      idp.tamper = tamper as FakeIdp["tamper"];
      const r = await signIn(server.baseUrl);
      expect(r.callback.status).toBe(401);
      expect(r.session).toBeUndefined();
      expect((await auditEntries())[0]).toMatchObject({
        action: "sign_in_failed",
        detail,
      });
    });

    it("refuses a token signed with a key the provider does not publish", async () => {
      idp.signingKey = rsaKey().priv;
      const r = await signIn(server.baseUrl);
      expect(r.callback.status).toBe(401);
      expect((await auditEntries())[0]?.detail).toBe("id_token_signature");
    });

    it("uses a code once: replaying the callback fails at the provider", async () => {
      const first = await signIn(server.baseUrl);
      expect(first.callback.status).toBe(200);
      const replay = await fetch(
        `${server.baseUrl}/login/oidc/callback?code=${first.code}&state=${first.state}`,
        { redirect: "manual", headers: { cookie: first.pending } },
      );
      expect(replay.status).toBe(401);
      expect((await auditEntries())[0]?.detail).toBe("token_request_failed");
    });

    it("puts the callback through the login limiter", async () => {
      auth.limiter = new LoginRateLimiter(1);
      expect((await signIn(server.baseUrl)).callback.status).toBe(200);
      const second = await signIn(server.baseUrl);
      expect(second.callback.status).toBe(429);
      expect(second.callback.headers.get("retry-after")).toMatch(/^\d+$/);
    });

    it("charges the login budget only after the state matched", async () => {
      auth.limiter = new LoginRateLimiter(3);
      for (let i = 0; i < 12; i++) {
        const bad = await rawRequest(
          server.baseUrl,
          "GET",
          "/login/oidc/callback?code=x&state=y",
        );
        expect(bad.status).toBe(401);
      }
      expect((await postLogin(server.baseUrl, "wrong-guess-123")).status).toBe(
        401,
      );
      // A matching state does spend it.
      expect((await signIn(server.baseUrl)).callback.status).toBe(200);
    });

    it("answers 503 at the start when the provider's metadata cannot be read", async () => {
      const saved = auth.oidc;
      try {
        auth.oidc = new OidcClient((saved as OidcClient).config);
        idp.down = 500;
        const res = await fetch(`${server.baseUrl}/login/oidc`, {
          redirect: "manual",
        });
        expect(res.status).toBe(503);
        expect(await res.text()).toContain("Single sign-on is unavailable");
      } finally {
        auth.oidc = saved;
      }
    });
  });

  describe("roles", () => {
    it("tells the UI who the request is (MetaResponse.access)", async () => {
      const { session } = await signInAs({ sub: "meta-viewer" });
      expect((await meta(session)).body.access).toEqual({
        role: "viewer",
        kind: "oidc",
        label: "ada@example.com",
      });
      const admin = await signInAs({
        sub: "meta-admin",
        groups: [ADMIN_GROUP],
        email: undefined,
        name: "Grace",
      });
      expect((await meta(admin.session)).body.access).toEqual({
        role: "admin",
        kind: "oidc",
        label: "Grace",
      });
      expect((await meta(server.cookie)).body.access).toEqual({
        role: "admin",
        kind: "password",
      });
    });

    it("shows a viewer alert webhook URLs cut to their host, and an admin the whole URL", async () => {
      const hook = `${idp.issuer}/hooks/T000/B000/secret-part`;
      const created = await server.call("POST", "/api/v1/alerts", {
        name: "Shop errors",
        service: "shop",
        metric: "error_rate",
        threshold: 0.1,
        windowMinutes: 5,
        forMinutes: 0,
        webhookUrl: hook,
      });
      expect(created.status).toBe(201);
      const { rule } = (await created.json()) as { rule: { id: string } };
      const { session } = await signInAs({ sub: "hook-viewer" });
      const list = await (await as(session, "GET", "/api/v1/alerts")).text();
      expect(list).not.toContain("secret-part");
      expect(list).toContain(`"webhookUrl":"${idp.issuer}/…"`);
      const one = await (
        await as(session, "GET", `/api/v1/alerts/${rule.id}`)
      ).json();
      expect((one as { webhookUrl: string }).webhookUrl).toBe(
        `${idp.issuer}/…`,
      );
      const admin = await (
        await server.call("GET", `/api/v1/alerts/${rule.id}`)
      ).json();
      expect((admin as { webhookUrl: string }).webhookUrl).toBe(hook);
    });

    it("lets a viewer read every page and the query API, and change nothing", async () => {
      const { session } = await signInAs({
        sub: "viewer-1",
        groups: [VIEWER_GROUP],
      });
      for (const path of [
        "/",
        "/api/v1/meta",
        "/api/v1/traces",
        "/api/v1/alerts",
        "/api/v1/slos",
        "/api/v1/instances",
        "/api/v1/remote-profiles",
      ]) {
        const res = await as(session, "GET", path);
        await res.arrayBuffer();
        expect(res.status, path).toBe(200);
      }
      for (const [method, path, body] of [
        ["POST", "/api/v1/alerts", { name: "x" }],
        ["PATCH", "/api/v1/alerts/1", { name: "x" }],
        ["DELETE", "/api/v1/alerts/1", undefined],
        ["POST", "/api/v1/alerts/1/test", undefined],
        ["POST", "/api/v1/slos", { name: "x" }],
        ["PATCH", "/api/v1/slos/1", { name: "x" }],
        ["DELETE", "/api/v1/slos/1", undefined],
        ["POST", "/api/v1/tokens", { name: "x" }],
        ["DELETE", "/api/v1/tokens/1", undefined],
        [
          "POST",
          "/api/v1/remote-profiles",
          { service: "s", instanceId: "i", durationSeconds: 5 },
        ],
        // Error triage (issue #26): a viewer reads the groups, never triages them.
        ["POST", "/api/v1/errors/groups/resolve", TRIAGE_BODY],
        ["POST", "/api/v1/errors/groups/ignore", TRIAGE_BODY],
        ["POST", "/api/v1/errors/groups/reopen", TRIAGE_BODY],
        ["PUT", "/api/v1/meta", {}],
        ["GET", "/api/v1/tokens", undefined],
        ["GET", "/api/v1/audit", undefined],
      ] as const) {
        const res = await as(session, method, path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(corsHeaders(res.headers)).toEqual([]);
        const json = (await res.json()) as { error?: { code?: string } };
        expect(json.error?.code, `${method} ${path}`).toBe("forbidden");
      }
    });

    it("lets an admin change things, and records who did it", async () => {
      const { session } = await signInAs({
        sub: "admin-1",
        email: "grace@example.com",
        groups: [VIEWER_GROUP, ADMIN_GROUP],
      });
      const created = await as(session, "POST", "/api/v1/tokens", {
        name: "ci",
      });
      expect(created.status).toBe(201);
      const { token } = (await created.json()) as ApiTokenCreateResponse;
      const revoked = await as(session, "DELETE", `/api/v1/tokens/${token.id}`);
      expect(revoked.status).toBe(204);
      // A refused write (400) is not recorded.
      const bad = await as(session, "POST", "/api/v1/tokens", { name: "" });
      expect(bad.status).toBe(400);

      const entries = await auditEntries();
      const mine = entries.filter((e) => e.actor.label === "grace@example.com");
      expect(mine.map((e) => e.action).slice(0, 3)).toEqual([
        "token.revoke",
        "token.create",
        "sign_in",
      ]);
      expect(mine[0]).toMatchObject({
        actor: { kind: "oidc" },
        target: String(token.id),
        outcome: "ok",
        clientAddress: "127.0.0.1",
      });
      expect(mine[1]?.target).toBe(String(token.id));
      expect(mine[2]?.detail).toBe("admin");
      expect(mine[0]?.atUnixMs).toBeGreaterThan(Date.now() - 60_000);
      // Never a secret in the log.
      expect(JSON.stringify(entries)).not.toContain("nxt_");

      // Error triage is an admin write too, and audited (issue #26 with #34).
      const triaged = await as(
        session,
        "POST",
        "/api/v1/errors/groups/resolve",
        TRIAGE_BODY,
      );
      expect(triaged.status).toBe(200);
      await triaged.arrayBuffer();
      const after = (await auditEntries()).filter(
        (e) => e.actor.label === "grace@example.com",
      );
      expect(after[0]).toMatchObject({
        action: "error_group.resolve",
        outcome: "ok",
      });
    });

    it("applies a role change at the next request of an open session", async () => {
      const admin = await signInAs({ sub: "changes", groups: [ADMIN_GROUP] });
      expect((await meta(admin.session)).body.access?.role).toBe("admin");
      // The provider now puts the user in the viewer group only; they sign in once more.
      await signInAs({ sub: "changes", groups: [VIEWER_GROUP] });
      expect((await meta(admin.session)).body.access?.role).toBe("viewer");
      expect(
        (await as(admin.session, "POST", "/api/v1/tokens", { name: "x" }))
          .status,
      ).toBe(403);
    });

    it("ends every session of a user the mapping refuses, and of a user removed from the table", async () => {
      const a = await signInAs({ sub: "leaver", email: "leaver@example.com" });
      expect((await meta(a.session)).status).toBe(200);
      idp.claims = {
        sub: "leaver",
        email: "leaver@example.com",
        groups: ["sales"],
      };
      const refused = await signIn(server.baseUrl);
      expect(refused.callback.status).toBe(403);
      expect(await refused.callback.text()).toContain("not in a group");
      expect(refused.session).toBeUndefined();
      expect((await meta(a.session)).status).toBe(401);
      expect((await auditEntries())[0]).toMatchObject({
        action: "sign_in_failed",
        detail: "not_allowed",
        actor: { kind: "oidc", label: "leaver@example.com" },
      });

      const b = await signInAs({ sub: "deleted" });
      await db.pool.query(
        "DELETE FROM dashboard_users WHERE subject = 'deleted'",
      );
      expect((await meta(b.session)).status).toBe(401);
    });

    it("keeps sessions from before a removal dead when the user is added back", async () => {
      const claims = { sub: "returner", email: "returner@example.com" };
      const old = await signInAs(claims);
      expect((await meta(old.session)).status).toBe(200);
      idp.claims = { ...claims, groups: ["sales"] };
      expect((await signIn(server.baseUrl)).callback.status).toBe(403);
      expect((await meta(old.session)).status).toBe(401);
      // Session issue times have a resolution of one second.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const fresh = await signInAs(claims);
      expect((await meta(fresh.session)).status).toBe(200);
      expect((await meta(old.session)).status).toBe(401);
    });

    it("signs a user out: the session is revoked and the sign-out audited", async () => {
      const { session } = await signInAs({
        sub: "bye",
        email: "bye@example.com",
      });
      const res = await as(session, "POST", "/logout");
      expect(res.status).toBe(303);
      expect((await meta(session)).status).toBe(401);
      expect((await auditEntries())[0]).toMatchObject({
        action: "sign_out",
        actor: { kind: "oidc", label: "bye@example.com" },
      });
    });

    it("refuses a forged user session (another user id under the same MAC)", async () => {
      const { session } = await signInAs({ sub: "forge" });
      const forged = session.replace(
        /\.(\d+)\.([\w-]{43})$/,
        (_m, id, mac) => `.${Number(id) + 1}.${mac}`,
      );
      expect((await meta(forged)).status).toBe(401);
    });
  });

  describe("the break-glass password and the audit log", () => {
    it("records password sign-ins, failed ones without the guess, and keeps the password as admin", async () => {
      expect((await postLogin(server.baseUrl, "wrong-guess-123")).status).toBe(
        401,
      );
      expect((await postLogin(server.baseUrl, ADMIN_PW)).status).toBe(303);
      const entries = await auditEntries();
      expect(entries[0]).toMatchObject({
        action: "sign_in",
        actor: { kind: "password", label: "break-glass admin" },
      });
      expect(entries[1]).toMatchObject({
        action: "sign_in_failed",
        detail: "wrong_password",
        actor: { kind: "anonymous" },
      });
      expect(JSON.stringify(entries)).not.toContain("wrong-guess-123");
      expect(JSON.stringify(entries)).not.toContain(ADMIN_PW);
    });

    it("pages the audit log with before, and validates its parameters", async () => {
      // Newest first by numeric id, past entry 9 (a text sort would put "9" before "13").
      const ids = (await auditEntries()).map((e) => Number(e.id));
      expect(ids.length).toBeGreaterThan(20);
      expect(ids).toEqual([...ids].sort((a, b) => b - a));
      const first = await server.call("GET", "/api/v1/audit?limit=2");
      const page = ((await first.json()) as AuditListResponse).entries;
      expect(page).toHaveLength(2);
      const next = await server.call(
        "GET",
        `/api/v1/audit?limit=2&before=${page[1]?.id}`,
      );
      const rest = ((await next.json()) as AuditListResponse).entries;
      expect(Number(rest[0]?.id)).toBeLessThan(Number(page[1]?.id));
      for (const q of [
        "limit=0",
        "limit=201",
        "before=abc",
        "before=-1",
        "other=1",
      ]) {
        const res = await server.call("GET", `/api/v1/audit?${q}`);
        expect(res.status, q).toBe(400);
      }
    });

    it("never lets an API token read the audit log", async () => {
      const created = await server.call("POST", "/api/v1/tokens", {
        name: "reader",
      });
      const { secret } = (await created.json()) as ApiTokenCreateResponse;
      const res = await fetch(`${server.baseUrl}/api/v1/audit`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(res.status).toBe(401);
      const metaRes = await fetch(`${server.baseUrl}/api/v1/meta`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(((await metaRes.json()) as MetaResponse).access).toEqual({
        role: "viewer",
        kind: "token",
      });
    });

    it("deletes audit entries past retention", async () => {
      await db.pool.query(
        "INSERT INTO audit_log (at, actor_kind, actor_label, action, outcome) VALUES (now() - interval '30 days', 'password', 'old', 'sign_in', 'ok')",
      );
      await new PostgresAuditStore(db.pool).prune(7);
      const { rows } = await db.pool.query(
        "SELECT count(*)::int AS n FROM audit_log WHERE actor_label = 'old'",
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe("faults", () => {
    it("still answers an audited write when the audit log cannot be written", async () => {
      const log = server.app.get(AuditLog);
      const failing = {
        insert: () => {
          throw new Error("boom");
        },
        list: async () => [],
        prune: async () => undefined,
      };
      log.useStore(failing);
      try {
        const res = await server.call("POST", "/api/v1/tokens", {
          name: "fault",
        });
        expect(res.status).toBe(201);
        failing.insert = () => Promise.reject(new Error("boom")) as never;
        const { session } = await signInAs({ sub: "fault-user" });
        expect((await meta(session)).status).toBe(200);
      } finally {
        log.useStore(new PostgresAuditStore(db.pool));
      }
    });

    it("fails closed when the user store cannot answer: sign-in and user sessions answer 503", async () => {
      const { session } = await signInAs({ sub: "store-fault" });
      const users = (auth as unknown as { users: unknown }).users;
      (auth as unknown as { users: unknown }).users = {
        get: () => Promise.reject(new Error("down")),
        signIn: () => Promise.reject(new Error("down")),
        refuse: () => Promise.reject(new Error("down")),
      };
      try {
        expect((await meta(session)).status).toBe(503);
        const r = await signIn(server.baseUrl);
        expect(r.callback.status).toBe(503);
        expect(r.session).toBeUndefined();
        // The break-glass password does not need the user table.
        expect((await meta(server.cookie)).status).toBe(200);
      } finally {
        (auth as unknown as { users: unknown }).users = users;
      }
    });
  });

  describe("password login switched off", () => {
    let only: AlertsServer;
    beforeAll(async () => {
      only = await startAlertsServer(db.url, {
        ...oidcEnv(idp),
        NESTRIX_ADMIN_PASSWORD_LOGIN: "false",
      });
    });
    afterAll(async () => {
      await only?.close();
    });

    it("offers no password form, refuses POST /login and every existing password session", async () => {
      const html = await (await fetch(`${only.baseUrl}/login`)).text();
      expect(html).not.toContain('type="password"');
      expect(html).toContain('href="/login/oidc"');
      expect((await postLogin(only.baseUrl, ADMIN_PW)).status).toBe(403);
      const cookie = signedCookie(
        undefined,
        undefined,
        undefined,
        Number(new URL(only.baseUrl).port),
      );
      const res = await fetch(`${only.baseUrl}/api/v1/meta`, {
        headers: { cookie },
      });
      expect(res.status).toBe(401);
    });
  });
});
