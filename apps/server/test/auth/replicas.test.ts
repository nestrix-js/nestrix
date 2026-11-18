/**
 * Several server instances on one PostgreSQL (issue #31, D-96): a session issued by A is accepted
 * by B with the same secret and after A restarts; logout on A is refused by B on the next request;
 * the login limiter's window is shared and keys on the forwarded client only behind a trusted
 * proxy; the stores fail closed when the database cannot answer.
 *
 * The cookie name carries the port the server listens on (`nestrix_admin_<port>`). Replicas behind
 * a load balancer listen on the same port; here each instance has its own, so a cookie from A is
 * sent to B under B's name (`asCookieFor`), which is what the browser does with one name.
 */
import "reflect-metadata";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminAuth } from "../../src/auth/admin-auth.js";
import {
  PostgresLoginLimiter,
  PostgresSessionRevocations,
} from "../../src/auth/session-store.js";
import { runMigrations } from "../../src/storage/migrate.js";
import { type AlertsServer, startAlertsServer } from "../alerts/helpers.js";
import {
  createTestDb,
  noDatabase,
  skipReason,
  type TestDb,
} from "../storage/helpers.js";
import { ADMIN_PW, originOf, postLogin } from "./helpers.js";

const TRUSTED = { NESTRIX_TRUSTED_PROXIES: "127.0.0.1/32" };

function cookieValue(setCookie: string | null): string {
  const pair = (setCookie ?? "").split(";", 1)[0] ?? "";
  const value = pair.slice(pair.indexOf("=") + 1);
  if (!/^v1\./.test(value)) throw new Error(`no session cookie: ${setCookie}`);
  return value;
}

function asCookieFor(server: AlertsServer, value: string): string {
  return `nestrix_admin_${new URL(server.baseUrl).port}=${value}`;
}

async function status(
  server: AlertsServer,
  path: string,
  cookie?: string,
): Promise<number> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
    redirect: "manual",
  });
  await res.arrayBuffer();
  return res.status;
}

let clientSeq = 0;
/** A distinct client address per call, so tests do not share a limiter window. */
function freshClient(): string {
  clientSeq++;
  return `198.51.${100 + Math.floor(clientSeq / 250)}.${clientSeq % 250}`;
}

/** Signs in on `server` as `client` (through the trusted proxy) and returns the cookie value. */
async function signIn(server: AlertsServer, client = freshClient()) {
  const res = await postLogin(server.baseUrl, ADMIN_PW, {
    "x-forwarded-for": client,
  });
  expect(res.status).toBe(303);
  return cookieValue(res.headers.get("set-cookie"));
}

describe.skipIf(noDatabase)(`several instances ${skipReason}`, () => {
  let db: TestDb;
  let a: AlertsServer;
  let b: AlertsServer;

  beforeAll(async () => {
    db = await createTestDb("replicas");
    // Both start (and migrate) at once against the same database.
    [a, b] = await Promise.all([
      startAlertsServer(db.url, TRUSTED),
      startAlertsServer(db.url, TRUSTED),
    ]);
  });

  afterAll(async () => {
    await a?.close();
    await b?.close();
    await db?.drop();
  });

  it("uses the PostgreSQL stores, not in-process ones", () => {
    const internals = a.app.get(AdminAuth) as unknown as {
      revocations: unknown;
      limiter: unknown;
    };
    expect(internals.revocations).toBeInstanceOf(PostgresSessionRevocations);
    expect(internals.limiter).toBeInstanceOf(PostgresLoginLimiter);
  });

  it("a session issued by A is accepted by B (same secret)", async () => {
    const value = await signIn(a);
    expect(await status(a, "/api/v1/meta", asCookieFor(a, value))).toBe(200);
    expect(await status(b, "/api/v1/meta", asCookieFor(b, value))).toBe(200);
    expect(await status(b, "/", asCookieFor(b, value))).toBe(200);
  });

  it("an instance with another secret refuses it", async () => {
    const value = await signIn(a);
    const other = await startAlertsServer(db.url, {
      ...TRUSTED,
      NESTRIX_SESSION_SECRET: "o".repeat(40),
    });
    try {
      expect(
        await status(other, "/api/v1/meta", asCookieFor(other, value)),
      ).toBe(401);
    } finally {
      await other.close();
    }
  });

  it("logout on A is refused by B with the very next request, and stays refused after a restart", async () => {
    const value = await signIn(b);
    expect(await status(b, "/api/v1/meta", asCookieFor(b, value))).toBe(200);
    expect(await status(a, "/api/v1/meta", asCookieFor(a, value))).toBe(200);
    const out = await fetch(`${a.baseUrl}/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: asCookieFor(a, value), origin: originOf(a.baseUrl) },
    });
    expect(out.status).toBe(303);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    // No wait: B asks the database on every request.
    expect(await status(b, "/api/v1/meta", asCookieFor(b, value))).toBe(401);
    expect(await status(b, "/", asCookieFor(b, value))).toBe(303);
    expect(await status(a, "/api/v1/meta", asCookieFor(a, value))).toBe(401);
    const { rows } = await db.pool.query(
      "SELECT nonce, expires_at FROM admin_session_revocations WHERE nonce = $1",
      [value.split(".")[2]],
    );
    expect(rows).toHaveLength(1);
    expect(Math.round((rows[0].expires_at as Date).getTime() / 1000)).toBe(
      Number(value.split(".")[1]),
    );

    const restarted = await startAlertsServer(db.url, TRUSTED);
    try {
      expect(
        await status(restarted, "/api/v1/meta", asCookieFor(restarted, value)),
      ).toBe(401);
    } finally {
      await restarted.close();
    }
  });

  it("a session stays valid after its instance restarts", async () => {
    const restartable = await startAlertsServer(db.url, TRUSTED);
    const value = await signIn(restartable);
    await restartable.close();
    const again = await startAlertsServer(db.url, TRUSTED);
    try {
      expect(
        await status(again, "/api/v1/meta", asCookieFor(again, value)),
      ).toBe(200);
    } finally {
      await again.close();
    }
  });

  it("deletes revocations of long-expired sessions when a new one is written", async () => {
    await db.pool.query(
      `INSERT INTO admin_session_revocations (nonce, expires_at)
       VALUES ('AAAAAAAAAAAAAAAAAAAAAA', now() - interval '2 hours'),
              ('BBBBBBBBBBBBBBBBBBBBBB', now() - interval '10 minutes')`,
    );
    const store = new PostgresSessionRevocations(db.pool);
    await store.revoke({
      nonce: "CCCCCCCCCCCCCCCCCCCCCC",
      expiresAtSeconds: Math.floor(Date.now() / 1000) + 600,
    });
    const { rows } = await db.pool.query<{ nonce: string }>(
      "SELECT nonce FROM admin_session_revocations WHERE nonce IN ('AAAAAAAAAAAAAAAAAAAAAA','BBBBBBBBBBBBBBBBBBBBBB','CCCCCCCCCCCCCCCCCCCCCC') ORDER BY nonce",
    );
    // Within the one-hour margin a revocation is kept (instance clocks may differ).
    expect(rows.map((r) => r.nonce)).toEqual([
      "BBBBBBBBBBBBBBBBBBBBBB",
      "CCCCCCCCCCCCCCCCCCCCCC",
    ]);
    // Idempotent.
    await store.revoke({
      nonce: "CCCCCCCCCCCCCCCCCCCCCC",
      expiresAtSeconds: Math.floor(Date.now() / 1000) + 600,
    });
  });

  describe("login limiter", () => {
    const wrong = (server: AlertsServer, xff?: string) =>
      postLogin(
        server.baseUrl,
        "wrong-password-x",
        xff === undefined ? {} : { "x-forwarded-for": xff },
      );

    it("shares one client's window across instances", async () => {
      const client = freshClient();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await wrong(i % 2 === 0 ? a : b, client)).status);
      }
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
      const refused = await wrong(a, client);
      expect(refused.status).toBe(429);
      const retry = Number(refused.headers.get("retry-after"));
      expect(retry).toBeGreaterThanOrEqual(1);
      expect(retry).toBeLessThanOrEqual(60);
      // The right password is refused too while the window is full.
      expect(
        (await postLogin(b.baseUrl, ADMIN_PW, { "x-forwarded-for": client }))
          .status,
      ).toBe(429);
      // Another client behind the same proxy is not affected.
      await signIn(b);
    });

    it("keys on the forwarded IPv6 /64 behind the trusted proxy", async () => {
      for (let i = 1; i <= 5; i++) {
        expect((await wrong(a, `2001:db8:31:1::${i}`)).status).toBe(401);
      }
      expect((await wrong(b, "2001:db8:31:1:ffff::1")).status).toBe(429);
      expect((await wrong(b, "2001:db8:31:2::1")).status).toBe(401);
    });

    it("ignores X-Forwarded-For when the peer is not a trusted proxy", async () => {
      // Its own database, so the peer's (127.0.0.1) window is not shared with other tests.
      const own = await createTestDb("replicas_untrusted");
      const untrusted = await startAlertsServer(own.url);
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 6; i++) {
          statuses.push((await wrong(untrusted, `203.0.113.${i + 1}`)).status);
        }
        // Six forged client addresses, one key: the socket peer.
        expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
        const { rows } = await own.pool.query<{ client: string }>(
          "SELECT client FROM admin_login_clients",
        );
        expect(rows.map((r) => r.client)).toEqual(["127.0.0.1"]);
      } finally {
        await untrusted.close();
        await own.drop();
      }
    });

    it("counts exactly under concurrent attempts from two instances", async () => {
      const one = new PostgresLoginLimiter(db.pool, { limit: 3 });
      const two = new PostgresLoginLimiter(db.pool, { limit: 3 });
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          (i % 2 === 0 ? one : two).take("concurrent-client"),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(3);
    });

    it("shares the global failure budget and keeps only its latest failures", async () => {
      const own = await createTestDb("replicas_budget");
      try {
        await runMigrations(own.pool);
        const one = new PostgresLoginLimiter(own.pool, {
          globalFailureLimit: 3,
        });
        const two = new PostgresLoginLimiter(own.pool, {
          globalFailureLimit: 3,
        });
        expect((await one.checkFailureBudget()).ok).toBe(true);
        await one.recordFailure();
        await two.recordFailure();
        expect((await two.checkFailureBudget()).ok).toBe(true);
        await one.recordFailure();
        const spent = await two.checkFailureBudget();
        expect(spent.ok).toBe(false);
        // A new client is refused while the budget is spent, and nothing is recorded for it.
        expect((await two.take("fresh-client")).ok).toBe(false);
        for (let i = 0; i < 5; i++) await two.recordFailure();
        const { rows } = await own.pool.query<{ n: number }>(
          "SELECT cardinality(failures) AS n FROM admin_login_failures",
        );
        expect(rows).toEqual([{ n: 3 }]);
        const clients = await own.pool.query(
          "SELECT 1 FROM admin_login_clients",
        );
        expect(clients.rows).toHaveLength(0);
      } finally {
        await own.drop();
      }
    });

    it("a window that has passed admits the client again", async () => {
      const limiter = new PostgresLoginLimiter(db.pool, {
        limit: 1,
        windowMs: 300,
      });
      expect((await limiter.take("short-window")).ok).toBe(true);
      expect((await limiter.take("short-window")).ok).toBe(false);
      await new Promise((r) => setTimeout(r, 400));
      expect((await limiter.take("short-window")).ok).toBe(true);
    });
  });

  describe("when the database cannot answer", () => {
    it("the stores reject", async () => {
      const dead = new pg.Pool({
        connectionString: "postgres://postgres@127.0.0.1:1/none",
        connectionTimeoutMillis: 2_000,
      });
      dead.on("error", () => undefined);
      try {
        await expect(
          new PostgresSessionRevocations(dead).revokedAmong(["x"]),
        ).rejects.toThrow();
        await expect(
          new PostgresLoginLimiter(dead).take("x"),
        ).rejects.toThrow();
        await expect(
          new PostgresLoginLimiter(dead).recordFailure(),
        ).rejects.toThrow();
      } finally {
        await dead.end();
      }
    });

    it("POST /login answers 503 without a cookie; a failure that cannot be counted is 503 too", async () => {
      const auth = a.app.get(AdminAuth);
      const shared = auth.limiter;
      const fail = async () => {
        throw new Error("injected fault");
      };
      try {
        auth.limiter = {
          take: fail,
          checkFailureBudget: fail,
          recordFailure: fail,
        };
        const res = await postLogin(a.baseUrl, ADMIN_PW, {
          "x-forwarded-for": freshClient(),
        });
        expect(res.status).toBe(503);
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(await res.text()).toContain("cannot reach its database");

        auth.limiter = {
          take: () => ({ ok: true }),
          checkFailureBudget: () => ({ ok: true }),
          recordFailure: fail,
        };
        const wrongPw = await postLogin(a.baseUrl, "wrong-password-x", {
          "x-forwarded-for": freshClient(),
        });
        expect(wrongPw.status).toBe(503);
        // A bad API token whose failure cannot be counted: 503, not 401.
        const token = await fetch(`${a.baseUrl}/api/v1/meta`, {
          headers: {
            authorization: `Bearer nxt_${Buffer.alloc(32, 9).toString("base64url")}`,
          },
        });
        expect(token.status).toBe(503);
      } finally {
        auth.limiter = shared;
      }
      // Restored: signing in works again.
      await signIn(a);
    });

    it("fails closed on a closed pool (real database client error)", async () => {
      const value = await signIn(a);
      const auth = a.app.get(AdminAuth) as unknown as {
        revocations: unknown;
      };
      const original = auth.revocations;
      const dead = new pg.Pool({
        connectionString: db.url,
      });
      await dead.end();
      auth.revocations = new PostgresSessionRevocations(dead);
      try {
        expect(await status(a, "/api/v1/meta", asCookieFor(a, value))).toBe(
          503,
        );
        expect(await status(a, "/", asCookieFor(a, value))).toBe(503);
        // GET /login shows the form rather than redirecting into a 503.
        expect(await status(a, "/login", asCookieFor(a, value))).toBe(200);
      } finally {
        auth.revocations = original;
      }
      expect(await status(a, "/api/v1/meta", asCookieFor(a, value))).toBe(200);
    });
  });
});
