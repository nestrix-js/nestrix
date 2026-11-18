/**
 * Admin-login state shared by every server instance through PostgreSQL (issue #31, D-96;
 * migration `0012_admin_sessions.sql`).
 *
 * - `PostgresSessionRevocations`: sessions ended by `/logout`, by nonce, until the session
 *   expires. Read on every request that carries a validly signed cookie (one indexed lookup;
 *   nothing cached that could go stale), so a logout on one instance is honoured by the next
 *   request on any other. Rows whose session expired more than an hour ago (a margin for clock
 *   differences between instances and the database) are deleted with each new revocation.
 * - `PostgresLoginLimiter`: the per-client `/login` window and the global failure budget, with the
 *   rules of the in-process `LoginRateLimiter` (5 attempts a minute per client, 60 failures a
 *   minute in all). Each decision is one statement: the upsert on a client's row takes its row
 *   lock, so concurrent attempts from several instances are counted exactly. Time is the
 *   database's (`statement_timestamp()`), so instances with skewed clocks agree. Per-client rows
 *   are bounded by the global budget (only an attempt that passes the budget check is recorded,
 *   and wrong passwords spend it) and deleted once their window has passed, at most once a
 *   window per instance. The budget check and the upsert are two statements, so concurrent
 *   attempts may overshoot the global budget by the number in flight, as before across a
 *   restart.
 *
 * Every method rejects when the database cannot answer; `AdminAuth` fails closed on that.
 */
import type { Pool } from "pg";
import type { LoginLimiter, LoginRateDecision } from "./login-rate-limit.js";
import type { SessionRevocations, VerifiedSession } from "./session.js";

/** Revocations kept this long after their session's expiry before they are deleted. */
const EXPIRED_MARGIN = "1 hour";
/** Longest limiter key stored (keys are IP addresses or IPv6 /64 prefixes; never this long). */
const MAX_CLIENT_KEY = 100;

export class PostgresSessionRevocations implements SessionRevocations {
  constructor(private readonly pool: Pool) {}

  async revokedAmong(nonces: readonly string[]): Promise<ReadonlySet<string>> {
    if (nonces.length === 0) return new Set();
    const { rows } = await this.pool.query<{ nonce: string }>(
      "SELECT nonce FROM admin_session_revocations WHERE nonce = ANY($1::text[])",
      [nonces],
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
  private lastPruneMs = 0;

  constructor(
    private readonly pool: Pool,
    options: PostgresLoginLimiterOptions = {},
  ) {
    this.limit = options.limit ?? 5;
    this.windowMs = options.windowMs ?? 60_000;
    this.globalFailureLimit = options.globalFailureLimit ?? 60;
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

  async take(key: string): Promise<LoginRateDecision> {
    const budget = await this.checkFailureBudget();
    if (!budget.ok) return budget;
    const client = key.slice(0, MAX_CLIENT_KEY) || "unknown";
    // In `DO UPDATE SET`, `c.*` is the row before this statement; RETURNING shows it after.
    const { rows } = await this.pool.query<{
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
    this.prune();
    return decision(row?.taken === true, row?.wait);
  }

  async recordFailure(): Promise<void> {
    await this.pool.query(
      `INSERT INTO admin_login_failures AS f (id, failures)
       VALUES (1, ARRAY[statement_timestamp()])
       ON CONFLICT (id) DO UPDATE SET failures = ARRAY(
         SELECT t FROM (
           SELECT t FROM unnest(f.failures || statement_timestamp()) t
            WHERE t > statement_timestamp() - $1 * interval '1 millisecond'
            ORDER BY t DESC LIMIT $2
         ) latest ORDER BY t
       )`,
      [this.windowMs, this.globalFailureLimit],
    );
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
