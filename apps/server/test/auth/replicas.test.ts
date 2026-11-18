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
import { STORAGE_POOL } from "../../src/storage/storage.module.js";
import { type AlertsServer, startAlertsServer } from "../alerts/helpers.js";
import { auth as ingestAuth, post } from "../ingest/helpers.js";
import {
  createTestDb,
  noDatabase,
  skipReason,
  type TestDb,
} from "../storage/helpers.js";
import { ADMIN_PW, originOf, postLogin, signedCookie } from "./helpers.js";

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
      const one = new PostgresLoginLimiter(db.pool, {
        limit: 3,
        maxInFlight: 20,
      });
      const two = new PostgresLoginLimiter(db.pool, {
        limit: 3,
        maxInFlight: 20,
      });
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
        expect((await one.reserveFailure()).ok).toBe(true);
        const held = await two.take("held-client");
        expect(held.ok).toBe(true);
        expect((await two.checkFailureBudget()).ok).toBe(true);
        expect((await one.reserveFailure()).ok).toBe(true);
        const spent = await two.checkFailureBudget();
        expect(spent.ok).toBe(false);
        // A new client is refused while the budget is spent, and nothing is recorded for it.
        expect((await two.take("fresh-client")).ok).toBe(false);
        for (let i = 0; i < 5; i++) {
          expect((await two.reserveFailure()).ok).toBe(false);
        }
        // Releasing a held slot (right password) makes room for exactly one more.
        if (held.ok) await one.release(held.reservation);
        expect((await two.reserveFailure()).ok).toBe(true);
        expect((await one.reserveFailure()).ok).toBe(false);
        const { rows } = await own.pool.query<{ n: number }>(
          "SELECT cardinality(failures) AS n FROM admin_login_failures",
        );
        expect(rows).toEqual([{ n: 3 }]);
        const clients = await own.pool.query(
          "SELECT 1 FROM admin_login_clients",
        );
        // Only the client that held a slot has a row.
        expect(clients.rows).toHaveLength(1);
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

  it("a burst of concurrent wrong passwords from distinct forwarded clients gets exactly the global budget to the password check", async () => {
    // Its own database and instances, so the budget starts empty.
    const own = await createTestDb("replicas_burst");
    const [x, y] = await Promise.all([
      startAlertsServer(own.url, TRUSTED),
      startAlertsServer(own.url, TRUSTED),
    ]);
    try {
      const statuses = await Promise.all(
        Array.from({ length: 300 }, async (_, i) => {
          const res = await postLogin(
            (i % 2 === 0 ? x : y).baseUrl,
            "wrong-password-x",
            { "x-forwarded-for": `203.0.${Math.floor(i / 250)}.${i % 250}` },
          );
          await res.arrayBuffer();
          return res.status;
        }),
      );
      expect(statuses.filter((s) => s === 401)).toHaveLength(60);
      expect(statuses.filter((s) => s === 429)).toHaveLength(240);
      const clients = await own.pool.query("SELECT 1 FROM admin_login_clients");
      expect(clients.rows).toHaveLength(60);
      const failures = await own.pool.query<{ n: number }>(
        "SELECT cardinality(failures) AS n FROM admin_login_failures",
      );
      expect(failures.rows).toEqual([{ n: 60 }]);
    } finally {
      await x.close();
      await y.close();
      await own.drop();
    }
  });

  it("one address flooding /login in concurrent batches cannot lock out the right password from other addresses", async () => {
    const own = await createTestDb("replicas_flood");
    const [x, y] = await Promise.all([
      startAlertsServer(own.url, TRUSTED),
      startAlertsServer(own.url, TRUSTED),
    ]);
    try {
      const flooder = "203.0.113.200";
      const outcomes: number[] = [];
      for (let round = 0; round < 10; round++) {
        const flood = Array.from({ length: 100 }, async (_, i) => {
          const res = await postLogin(
            (i % 2 === 0 ? x : y).baseUrl,
            "wrong-password-x",
            { "x-forwarded-for": flooder },
          );
          await res.arrayBuffer();
          return res.status;
        });
        // The admin signs in from another address while the batch is in flight.
        const admin = postLogin((round % 2 === 0 ? y : x).baseUrl, ADMIN_PW, {
          "x-forwarded-for": `192.0.2.${round + 10}`,
        }).then(async (res) => {
          await res.arrayBuffer();
          return res.status;
        });
        const [flooded, adminStatus] = await Promise.all([
          Promise.all(flood),
          admin,
        ]);
        outcomes.push(adminStatus);
        // The flooder gets at most its own window: 5 attempts in the whole run.
        expect(
          flooded.filter((s) => s === 401).length,
          `round ${round}`,
        ).toBeLessThanOrEqual(round === 0 ? 5 : 0);
      }
      expect(outcomes).toEqual(Array(10).fill(303));
      const failures = await own.pool.query<{ n: number }>(
        "SELECT cardinality(failures) AS n FROM admin_login_failures",
      );
      expect(failures.rows).toEqual([{ n: 5 }]);
    } finally {
      await x.close();
      await y.close();
      await own.drop();
    }
  });

  it("200 concurrent wrong passwords from one address on one instance cost at most 5 limiter transactions, and ingest keeps working", async () => {
    const own = await createTestDb("replicas_pregate");
    const server = await startAlertsServer(own.url, TRUSTED);
    try {
      const auth = server.app.get(AdminAuth);
      const pool = server.app.get<pg.Pool>(STORAGE_POOL);
      let connects = 0;
      // The app's own pool (shared with ingest), with limiter connections counted.
      const counted = {
        connect: () => {
          connects++;
          return pool.connect();
        },
        query: pool.query.bind(pool),
      };
      auth.limiter = new PostgresLoginLimiter(counted as unknown as pg.Pool);
      const logins = Array.from({ length: 200 }, async () => {
        const res = await postLogin(server.baseUrl, "wrong-password-x", {
          "x-forwarded-for": "203.0.113.250",
        });
        await res.arrayBuffer();
        return res.status;
      });
      const ingest = post(
        `${server.baseUrl}/v1/traces`,
        JSON.stringify({ resourceSpans: [] }),
        { "content-type": "application/json", ...ingestAuth() },
      ).then(async (res) => {
        await res.arrayBuffer();
        return res.status;
      });
      const [statuses, ingestStatus] = await Promise.all([
        Promise.all(logins),
        ingest,
      ]);
      expect(connects).toBeLessThanOrEqual(5);
      expect(statuses.filter((s) => s === 401)).toHaveLength(5);
      expect(statuses.filter((s) => s === 429)).toHaveLength(195);
      expect(ingestStatus).toBe(200);
    } finally {
      await server.close();
      await own.drop();
    }
  });

  it("refused API tokens are limited per client across instances", async () => {
    const own = await createTestDb("replicas_tokens");
    const [x, y] = await Promise.all([
      startAlertsServer(own.url, TRUSTED),
      startAlertsServer(own.url, TRUSTED),
    ]);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        const res = await fetch(
          `${(i % 2 === 0 ? x : y).baseUrl}/api/v1/meta`,
          {
            headers: {
              authorization: `Bearer nxt_${Buffer.alloc(32, i + 1).toString("base64url")}`,
              "x-forwarded-for": "198.18.0.1",
            },
          },
        );
        await res.arrayBuffer();
        statuses.push(res.status);
      }
      // 5 in all, not 5 per instance.
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
      const { rows } = await own.pool.query<{ client: string }>(
        "SELECT client FROM admin_login_clients",
      );
      expect(rows.map((r) => r.client)).toEqual(["token:198.18.0.1"]);
      // Its /login window is separate.
      expect(
        (
          await postLogin(x.baseUrl, ADMIN_PW, {
            "x-forwarded-for": "198.18.0.1",
          })
        ).status,
      ).toBe(303);
    } finally {
      await x.close();
      await y.close();
      await own.drop();
    }
  });

  it("refuses a cookie past its expiry on the database's clock, even from an instance whose clock is behind", async () => {
    const auth = a.app.get(AdminAuth);
    const original = auth.nowSeconds;
    const real = Math.floor(Date.now() / 1000);
    const port = Number(new URL(a.baseUrl).port);
    // Two hours slow: past the one-hour margin after which revocations are deleted.
    auth.nowSeconds = () => real - 7200;
    try {
      const expired = signedCookie(real - 3600, undefined, undefined, port);
      expect(await status(a, "/api/v1/meta", expired)).toBe(401);
      // Not expired on either clock: still accepted, so the refusal above is the expiry check.
      const fresh = signedCookie(real + 600, undefined, undefined, port);
      expect(await status(a, "/api/v1/meta", fresh)).toBe(200);
    } finally {
      auth.nowSeconds = original;
    }
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
          new PostgresSessionRevocations(dead).revokedAmong([
            { nonce: "x", expiresAtSeconds: 1 },
          ]),
        ).rejects.toThrow();
        await expect(
          new PostgresLoginLimiter(dead).take("x"),
        ).rejects.toThrow();
        await expect(
          new PostgresLoginLimiter(dead).reserveFailure(),
        ).rejects.toThrow();
      } finally {
        await dead.end();
      }
    });

    it("POST /login answers 503 without a cookie; a token miss that cannot be counted is 503; a failed release still signs in", async () => {
      const auth = a.app.get(AdminAuth);
      const shared = auth.limiter;
      const fail = async () => {
        throw new Error("injected fault");
      };
      try {
        auth.limiter = {
          take: fail,
          release: fail,
          reserveFailure: fail,
          checkFailureBudget: fail,
        };
        const res = await postLogin(a.baseUrl, ADMIN_PW, {
          "x-forwarded-for": freshClient(),
        });
        expect(res.status).toBe(503);
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(await res.text()).toContain("cannot reach its database");
        // A bad API token whose failure cannot be counted: 503, not 401.
        const token = await fetch(`${a.baseUrl}/api/v1/meta`, {
          headers: {
            authorization: `Bearer nxt_${Buffer.alloc(32, 9).toString("base64url")}`,
          },
        });
        expect(token.status).toBe(503);

        auth.limiter = {
          take: () => ({ ok: true, reservation: { at: "x" } }),
          release: fail,
          reserveFailure: fail,
          checkFailureBudget: () => ({ ok: true }),
        };
        // The slot was reserved before the check: a wrong password is just 401.
        const wrongPw = await postLogin(a.baseUrl, "wrong-password-x", {
          "x-forwarded-for": freshClient(),
        });
        expect(wrongPw.status).toBe(401);
        // The right password signs in even if its slot cannot be released (it stays counted).
        const rightPw = await postLogin(a.baseUrl, ADMIN_PW, {
          "x-forwarded-for": freshClient(),
        });
        expect(rightPw.status).toBe(303);
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

describe("PostgresLoginLimiter's in-process guards (no database)", () => {
  /** A pool whose connections are handed out only when `open()` is called. */
  function heldPool() {
    let connects = 0;
    const gates: Array<() => void> = [];
    const pool = {
      connect: async () => {
        connects++;
        await new Promise<void>((r) => gates.push(r));
        return {
          query: async () => ({
            rows: [{ taken: true, reserved: true, at: "t" }],
          }),
          release: () => undefined,
        };
      },
      query: async () => ({ rows: [] }),
    };
    return {
      pool: pool as unknown as pg.Pool,
      connects: () => connects,
      open: () => {
        for (const g of gates.splice(0)) g();
      },
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 10));

  it("holds at most maxInFlight connections; waiters hold none; past the queue: 429 at once", async () => {
    const held = heldPool();
    const limiter = new PostgresLoginLimiter(held.pool, {
      limit: 100,
      maxInFlight: 2,
      maxQueued: 3,
    });
    const calls = Array.from({ length: 6 }, (_, i) => limiter.take(`c${i}`));
    // 2 running, 3 waiting, the 6th refused without asking for a connection.
    expect(await calls[5]).toEqual({ ok: false, retryAfterSeconds: 1 });
    await tick();
    expect(held.connects()).toBe(2);
    for (let i = 0; i < 5; i++) {
      held.open();
      await tick();
      expect(held.connects()).toBeLessThanOrEqual(5);
    }
    const results = await Promise.all(calls.slice(0, 5));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(held.connects()).toBe(5);
  });

  it("the pre-gate refuses a client past its window without any database work", async () => {
    const held = heldPool();
    const limiter = new PostgresLoginLimiter(held.pool, { limit: 2 });
    const first = [limiter.take("same"), limiter.take("same")];
    expect(await limiter.take("same")).toEqual({
      ok: false,
      retryAfterSeconds: 60,
    });
    for (let i = 0; i < 3; i++) {
      held.open();
      await tick();
    }
    await Promise.all(first);
    expect(held.connects()).toBe(2);
  });

  it("a waiter gives up after queueTimeoutMs with 429", async () => {
    const held = heldPool();
    const limiter = new PostgresLoginLimiter(held.pool, {
      limit: 100,
      maxInFlight: 1,
      queueTimeoutMs: 50,
    });
    const running = limiter.take("a");
    expect(await limiter.take("b")).toEqual({
      ok: false,
      retryAfterSeconds: 1,
    });
    held.open();
    await running;
    expect(held.connects()).toBe(1);
  });
});
