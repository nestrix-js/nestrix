/**
 * Admin-login state shared by every server instance through PostgreSQL (issue #31, D-96;
 * migration `0014_admin_sessions.sql`).
 *
 * - `PostgresSessionRevocations`: sessions ended by `/logout`, by nonce, until the session
 *   expires. Read on every request that carries a validly signed cookie (one indexed lookup;
 *   nothing cached that could go stale), so a logout on one instance is honoured by the next
 *   request on any other. Rows whose session expired more than an hour ago (a margin for clock
 *   differences between instances and the database) are deleted with each new revocation.
 * - `PostgresLoginLimiter`: the per-client `/login` window and the global failure budget, with the
 *   rules of the in-process `LoginRateLimiter` (5 attempts a minute per client, 60 failures a
 *   minute in all). An attempt is one transaction (`take`): the client's row first, under its
 *   lock (so a client is counted exactly and its concurrent attempts queue), then, only if the
 *   client's window admits it, a slot of the global budget under the budget row's lock (so at most
 *   the budget get through across every instance); a budget refusal rolls the client's attempt
 *   back. The slot is released when the password is right; otherwise it is the attempt's failure.
 *   So no burst gets more attempts to the password check than the budget, and one flooding
 *   address holds at most the slots its own window admits (5), never the whole budget. Refused
 *   API tokens go through `take` too, under the key `token:<client>`. New client rows per window
 *   are at most the budget plus correct-password sign-ins; rows whose window has passed are
 *   deleted at most once a window per instance. Time is the database's
 *   (`statement_timestamp()`), so instances with skewed clocks agree.
 *
 * Every method rejects when the database cannot answer; `AdminAuth` fails closed on that.
 */
import type { Pool, PoolClient } from "pg";
import type {
  LoginLimiter,
  LoginRateDecision,
  LoginReservation,
  LoginTake,
} from "./login-rate-limit.js";
import { LoginRateLimiter } from "./login-rate-limit.js";
import type { SessionRevocations, VerifiedSession } from "./session.js";

/** Revocations kept this long after their session's expiry before they are deleted. */
const EXPIRED_MARGIN = "1 hour";
/** A pool or one checked-out connection (inside a transaction). */
type Queryable = Pick<PoolClient, "query">;
/** Longest limiter key stored (keys are IP addresses or IPv6 /64 prefixes; never this long). */
const MAX_CLIENT_KEY = 100;

export class PostgresSessionRevocations implements SessionRevocations {
  constructor(private readonly pool: Pool) {}

  /**
   * Revoked sessions, and sessions already expired by the **database's** clock. The second part
   * closes the clock-skew gap: revocations are deleted by the database's clock (an hour after
   * expiry), so an instance whose clock is behind could otherwise accept a signed-out cookie
   * whose row is gone. With it, a cookie past its expiry on the database's clock is refused
   * whatever the instance's clock says, and a deleted row's cookie is always past it.
   */
  async revokedAmong(
    sessions: readonly VerifiedSession[],
  ): Promise<ReadonlySet<string>> {
    if (sessions.length === 0) return new Set();
    const { rows } = await this.pool.query<{ nonce: string }>(
      `SELECT s.nonce
         FROM unnest($1::text[], $2::float8[]) AS s(nonce, exp)
        WHERE to_timestamp(s.exp) <= now()
           OR EXISTS (SELECT 1 FROM admin_session_revocations r WHERE r.nonce = s.nonce)`,
      [sessions.map((s) => s.nonce), sessions.map((s) => s.expiresAtSeconds)],
    );
    return new Set(rows.map((r) => r.nonce));
  }

  async revoke(session: VerifiedSession): Promise<void> {
    await this.pool.query(
      `WITH expired AS (
         DELETE FROM admin_session_revocations
          WHERE expires_at < now() - interval '${EXPIRED_MARGIN}'
       )
       INSERT INTO admin_session_revocations (nonce, expires_at)
       VALUES ($1, to_timestamp($2))
       ON CONFLICT (nonce) DO NOTHING`,
      [session.nonce, session.expiresAtSeconds],
    );
  }
}

export interface PostgresLoginLimiterOptions {
  /** Attempts per client per window. Default 5. */
  limit?: number;
  /** Default 60 000. */
  windowMs?: number;
  /** Failed logins (and refused API tokens) per window across all clients. Default 60. */
  globalFailureLimit?: number;
  /**
   * `take` transactions running at once on this instance (each holds a pool connection, and the
   * pool of 10 is shared with ingest and the query API). Further callers wait in process, holding
   * no connection. Default 2.
   */
  maxInFlight?: number;
  /** Callers waiting for a transaction slot; beyond: 429 with `Retry-After: 1`. Default 500. */
  maxQueued?: number;
  /** Longest wait for a slot; then 429 with `Retry-After: 1`. Default 5 000. */
  queueTimeoutMs?: number;
}

function decision(taken: boolean, waitSeconds: unknown): LoginRateDecision {
  if (taken) return { ok: true };
  const wait = Number(waitSeconds);
  return {
    ok: false,
    retryAfterSeconds: Number.isFinite(wait) ? Math.max(1, Math.ceil(wait)) : 1,
  };
}

export class PostgresLoginLimiter implements LoginLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly globalFailureLimit: number;
  private readonly maxInFlight: number;
  /**
   * Per-instance pre-gate: the same per-client window (same key, same limit), checked
   * synchronously before any database work. It can only refuse more than the shared window,
   * never admit more (the database stays authoritative), so the shared guarantees hold. It is the
   * in-process `LoginRateLimiter`'s client window: bounded at `MAX_CLIENTS` live entries (fail
   * closed), expired ones pruned.
   */
  private readonly gate: LoginRateLimiter;
  private readonly maxQueued: number;
  private readonly queueTimeoutMs: number;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private lastPruneMs = 0;

  constructor(
    private readonly pool: Pick<Pool, "connect" | "query">,
    options: PostgresLoginLimiterOptions = {},
  ) {
    this.limit = options.limit ?? 5;
    this.windowMs = options.windowMs ?? 60_000;
    this.globalFailureLimit = options.globalFailureLimit ?? 60;
    this.maxInFlight = options.maxInFlight ?? 2;
    this.maxQueued = options.maxQueued ?? 500;
    this.queueTimeoutMs = options.queueTimeoutMs ?? 5_000;
    this.gate = new LoginRateLimiter(this.limit, this.windowMs);
  }

  async checkFailureBudget(): Promise<LoginRateDecision> {
    // The row keeps at most the budget's latest failures, so when it is full its oldest one in the
    // window is exactly when the budget has room again.
    const { rows } = await this.pool.query<{ n: number; wait: string | null }>(
      `SELECT count(*)::int AS n,
              extract(epoch FROM (min(t) + $1 * interval '1 millisecond' - statement_timestamp())) AS wait
         FROM admin_login_failures f, unnest(f.failures) t
        WHERE f.id = 1 AND t > statement_timestamp() - $1 * interval '1 millisecond'`,
      [this.windowMs],
    );
    const row = rows[0];
    return decision((row?.n ?? 0) < this.globalFailureLimit, row?.wait);
  }

  /**
   * Reserves one slot of the global budget: one statement under the row lock of
   * `admin_login_failures` (id 1) appends `statement_timestamp()` only while fewer than the budget
   * are in the window, so concurrent callers on every instance are serialised and at most the
   * budget succeed. Returns the slot's time (text, microseconds) when reserved.
   */
  private async reserve(
    q: Queryable,
  ): Promise<
    { ok: true; at: string } | { ok: false; retryAfterSeconds: number }
  > {
    const { rows } = await q.query<{
      reserved: boolean;
      at: string;
      wait: string | null;
    }>(
      `INSERT INTO admin_login_failures AS f (id, failures, reserved)
       VALUES (1, ARRAY[statement_timestamp()], $2::int > 0)
       ON CONFLICT (id) DO UPDATE SET
         reserved = (SELECT count(*) FROM unnest(f.failures) t
                      WHERE t > statement_timestamp() - $1 * interval '1 millisecond') < $2,
         failures = ARRAY(SELECT t FROM unnest(f.failures) t
                           WHERE t > statement_timestamp() - $1 * interval '1 millisecond'
                           ORDER BY t)
                    || CASE WHEN (SELECT count(*) FROM unnest(f.failures) t
                                   WHERE t > statement_timestamp() - $1 * interval '1 millisecond') < $2
                            THEN ARRAY[statement_timestamp()] ELSE '{}'::timestamptz[] END
       RETURNING reserved, statement_timestamp()::text AS at,
         extract(epoch FROM (failures[1] + $1 * interval '1 millisecond' - statement_timestamp())) AS wait`,
      [this.windowMs, this.globalFailureLimit],
    );
    const row = rows[0];
    if (row?.reserved === true) return { ok: true, at: row.at };
    const wait = Number(row?.wait);
    return {
      ok: false,
      retryAfterSeconds: Number.isFinite(wait)
        ? Math.max(1, Math.ceil(wait))
        : 1,
    };
  }

  async release(reservation: LoginReservation): Promise<void> {
    if (typeof reservation.at !== "string") return;
    // Removes one occurrence of the slot's time (none once it has left the window).
    await this.pool.query(
      `UPDATE admin_login_failures
          SET failures = CASE
                WHEN array_position(failures, $1::timestamptz) IS NULL THEN failures
                ELSE failures[:array_position(failures, $1::timestamptz) - 1]
                     || failures[array_position(failures, $1::timestamptz) + 1:]
              END
        WHERE id = 1`,
      [reservation.at],
    );
  }

  async reserveFailure(): Promise<LoginRateDecision> {
    const slot = await this.reserve(this.pool);
    return slot.ok ? { ok: true } : slot;
  }

  /**
   * One transaction on one connection: the client's window first (its upsert takes the client
   * row's lock), and only if that admits the attempt, a budget slot (the budget row's lock);
   * ROLLBACK when the budget refuses, so the client is not charged either. Lock order is always
   * client row, then budget row, so two attempts cannot deadlock (`reserveFailure` takes only the
   * budget row). Consequences: concurrent attempts from one client queue on its row lock and hold
   * at most the slots its window admits, so one flooding address cannot fill the budget with
   * attempts that would be refused anyway; and a client row is changed only by an attempt that
   * got a slot or by one its own window refused (an existing row), so new rows per window are at
   * most the budget plus correct-password sign-ins. If anything fails, the transaction is rolled
   * back and the call rejects (the caller answers 503).
   */
  async take(key: string): Promise<LoginTake> {
    // Before any database work: the per-instance pre-gate, synchronously (so concurrent calls see
    // each other), then one of `maxInFlight` transaction slots. A flood from one address thus costs
    // at most its admitted attempts in queries, and limiter work never holds more than
    // `maxInFlight` pool connections.
    const local = this.gate.allow(key.slice(0, MAX_CLIENT_KEY) || "unknown");
    if (!local.ok) return local;
    if (!(await this.acquire())) return { ok: false, retryAfterSeconds: 1 };
    try {
      return await this.transaction(key);
    } finally {
      this.handOver();
    }
  }

  /**
   * One of `maxInFlight` transaction slots. When all are taken the caller waits in process (no
   * connection held), at most `maxQueued` callers for at most `queueTimeoutMs`; beyond either,
   * `false` (the caller answers 429 with `Retry-After: 1`).
   */
  private acquire(): Promise<boolean> {
    if (this.inFlight < this.maxInFlight) {
      this.inFlight++;
      return Promise.resolve(true);
    }
    if (this.waiters.length >= this.maxQueued) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve(false);
      }, this.queueTimeoutMs);
      timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  /** Passes the finished transaction's slot to the next waiter, or frees it. */
  private handOver(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.inFlight--;
  }

  private async transaction(key: string): Promise<LoginTake> {
    const conn = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await conn.query("BEGIN");
      const client = await this.takeClient(conn, key);
      if (!client.ok) {
        await conn.query("COMMIT");
        return client;
      }
      const slot = await this.reserve(conn);
      if (!slot.ok) {
        await conn.query("ROLLBACK");
        return slot;
      }
      await conn.query("COMMIT");
      this.prune();
      return { ok: true, reservation: { at: slot.at } };
    } catch (error) {
      broken = error instanceof Error ? error : new Error(String(error));
      await conn.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      // A connection that failed mid-transaction is discarded, not returned to the pool.
      conn.release(broken);
    }
  }

  private async takeClient(
    q: Queryable,
    key: string,
  ): Promise<LoginRateDecision> {
    const client = key.slice(0, MAX_CLIENT_KEY) || "unknown";
    // In `DO UPDATE SET`, `c.*` is the row before this statement; RETURNING shows it after.
    const { rows } = await q.query<{
      taken: boolean;
      wait: string | null;
    }>(
      `INSERT INTO admin_login_clients AS c (client, attempts, taken, updated_at)
       VALUES ($1, ARRAY[statement_timestamp()], true, statement_timestamp())
       ON CONFLICT (client) DO UPDATE SET
         taken = (SELECT count(*) FROM unnest(c.attempts) t
                   WHERE t > statement_timestamp() - $3 * interval '1 millisecond') < $2,
         attempts = ARRAY(SELECT t FROM unnest(c.attempts) t
                           WHERE t > statement_timestamp() - $3 * interval '1 millisecond'
                           ORDER BY t)
                    || CASE WHEN (SELECT count(*) FROM unnest(c.attempts) t
                                   WHERE t > statement_timestamp() - $3 * interval '1 millisecond') < $2
                            THEN ARRAY[statement_timestamp()] ELSE '{}'::timestamptz[] END,
         updated_at = statement_timestamp()
       RETURNING taken,
         extract(epoch FROM (attempts[1] + $3 * interval '1 millisecond' - statement_timestamp())) AS wait`,
      [client, this.limit, this.windowMs],
    );
    const row = rows[0];
    return decision(row?.taken === true, row?.wait);
  }

  /** Deletes clients whose window has passed, at most once a window; never awaited, never throws. */
  private prune(): void {
    const now = Date.now();
    if (now - this.lastPruneMs < this.windowMs) return;
    this.lastPruneMs = now;
    try {
      this.pool
        .query(
          `DELETE FROM admin_login_clients
            WHERE updated_at < statement_timestamp() - $1 * interval '1 millisecond'`,
          [this.windowMs],
        )
        .catch(() => undefined);
    } catch {
      // Pruning is housekeeping: the next window tries again.
    }
  }
}
