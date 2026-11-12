/**
 * Read-only API tokens of the standalone server (docs/backlog/phase-8.md P8-01, D-74).
 *
 * A token is `nxt_` + 32 random bytes in base64url (43 characters, no padding). The server keeps
 * its SHA-256 (hex) and its first 8 characters for display; the plain token is returned once, by
 * `create`. A request authenticates with `Authorization: Bearer nxt_…`; `AdminAuth.middleware()`
 * decides which requests may (`GET`/`HEAD` on the query API's read routes only) and calls
 * `verify` here. Every verification reads the database (no cache), so a revoked token stops
 * working with the next request.
 *
 * Nothing in this file logs a token, a hash or a prefix.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { ApiToken } from "@nestrix-js/protocol";
import type { Pool } from "pg";
import { STORAGE_POOL } from "../storage/storage.module.js";

export const API_TOKEN_PREFIX = "nxt_";
/** The full shape of a token. Anything else is refused before the database is asked. */
export const API_TOKEN_PATTERN = /^nxt_[A-Za-z0-9_-]{43}$/;
/** Characters of the token kept for display. */
export const DISPLAY_PREFIX_LENGTH = 8;
/** Tokens that may exist unrevoked at once. */
export const MAX_ACTIVE_TOKENS = 100;
/** Rows `list` returns, newest first. */
export const MAX_LISTED_TOKENS = 500;
/** `last_used_at` is written at most this often per token. */
export const LAST_USED_INTERVAL_MS = 60_000;
export const MAX_TOKEN_NAME_LENGTH = 100;

/** A new random token. */
export function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Hex SHA-256 of the token's UTF-8 bytes. */
export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isApiTokenShape(value: unknown): value is string {
  return typeof value === "string" && API_TOKEN_PATTERN.test(value);
}

/** What a successful verification tells the guards. */
export interface VerifiedApiToken {
  /** Decimal string of the token's id. */
  readonly id: string;
}

/** What `AdminAuth` needs from the token store. */
export interface ApiTokenVerifier {
  /**
   * The token's id when `token` is a stored, unrevoked token; `undefined` otherwise. Rejects
   * (throws asynchronously) only when the database cannot answer.
   */
  verify(token: string): Promise<VerifiedApiToken | undefined>;
}

export type TokenNameValidation =
  | { ok: true; name: string }
  | { ok: false; message: string };

function hasControlCharacters(s: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  return /[\u0000-\u001f\u007f-\u009f]/.test(s);
}

/** Checks a `POST /api/v1/tokens` body: exactly `{ name }`, 1 to 100 characters after trimming. */
export function validateTokenCreate(body: unknown): TokenNameValidation {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "The body must be a JSON object." };
  }
  for (const key of Object.keys(body)) {
    if (key !== "name") {
      return { ok: false, message: `Unknown field: ${key.slice(0, 64)}.` };
    }
  }
  const raw = (body as { name?: unknown }).name;
  if (typeof raw !== "string") {
    return { ok: false, message: "name must be a string." };
  }
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_TOKEN_NAME_LENGTH) {
    return {
      ok: false,
      message: `name must have 1 to ${MAX_TOKEN_NAME_LENGTH} characters.`,
    };
  }
  if (hasControlCharacters(name) || !name.isWellFormed()) {
    return { ok: false, message: "name contains control characters." };
  }
  return { ok: true, name };
}

interface TokenRow {
  id: string | number;
  name: string;
  prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export function toApiToken(row: TokenRow): ApiToken {
  return {
    id: String(row.id),
    name: row.name,
    prefix: row.prefix,
    createdAtUnixMs: row.created_at.getTime(),
    lastUsedAtUnixMs: row.last_used_at?.getTime() ?? null,
    revokedAtUnixMs: row.revoked_at?.getTime() ?? null,
  };
}

/** Raised by `create` when `MAX_ACTIVE_TOKENS` unrevoked tokens exist. */
export class TooManyTokensError extends Error {}

const COLUMNS = "id, name, prefix, created_at, last_used_at, revoked_at";

/** API tokens in PostgreSQL (`api_tokens`). */
@Injectable()
export class ApiTokenStore implements ApiTokenVerifier {
  /** When each token's `last_used_at` was last written by this process (ms). Bounded. */
  private readonly lastWrite = new Map<string, number>();
  /** Milliseconds since the epoch. Replaceable in tests. */
  nowMs: () => number = () => Date.now();
  /** A pending `last_used_at` write, for tests to wait on. */
  lastUsedWrite: Promise<void> = Promise.resolve();

  constructor(@Inject(STORAGE_POOL) private readonly pool: Pool) {}

  /** Creates a token; the returned `secret` is not kept anywhere. */
  async create(name: string): Promise<{ token: ApiToken; secret: string }> {
    const secret = generateApiToken();
    // A soft cap that bounds the table: the count and the insert are one statement, but two
    // creates at the same instant can each see the other's row missing and both pass.
    const { rows } = await this.pool.query<TokenRow>(
      `INSERT INTO api_tokens (name, prefix, hash)
       SELECT $1, $2, $3
        WHERE (SELECT count(*) FROM api_tokens WHERE revoked_at IS NULL) < $4
       RETURNING ${COLUMNS}`,
      [
        name,
        secret.slice(0, DISPLAY_PREFIX_LENGTH),
        hashApiToken(secret),
        MAX_ACTIVE_TOKENS,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new TooManyTokensError();
    return { token: toApiToken(row), secret };
  }

  async list(): Promise<ApiToken[]> {
    const { rows } = await this.pool.query<TokenRow>(
      `SELECT ${COLUMNS} FROM api_tokens ORDER BY (revoked_at IS NULL) DESC, id DESC LIMIT $1`,
      [MAX_LISTED_TOKENS],
    );
    return rows.map(toApiToken);
  }

  /**
   * Revokes the token: true when it exists (an already revoked token keeps its first
   * `revoked_at`), false when there is no such id.
   */
  async revoke(id: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`,
      [id],
    );
    this.lastWrite.delete(String(id));
    return (rowCount ?? 0) > 0;
  }

  async verify(token: string): Promise<VerifiedApiToken | undefined> {
    if (!isApiTokenShape(token)) return undefined;
    const digest = hashApiToken(token);
    const { rows } = await this.pool.query<{
      id: string | number;
      hash: string;
    }>(
      "SELECT id, hash FROM api_tokens WHERE hash = $1 AND revoked_at IS NULL",
      [digest],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    // The lookup matched on the hash already; compare again in constant time so the decision
    // never rests on a non-constant-time comparison alone.
    const stored = Buffer.from(row.hash, "hex");
    const given = Buffer.from(digest, "hex");
    if (stored.length !== given.length || !timingSafeEqual(stored, given)) {
      return undefined;
    }
    const id = String(row.id);
    this.touch(id);
    return { id };
  }

  /** Writes `last_used_at` at most once a minute per token, without delaying the request. */
  private touch(id: string): void {
    try {
      const now = this.nowMs();
      const last = this.lastWrite.get(id);
      if (
        last !== undefined &&
        now - last < LAST_USED_INTERVAL_MS &&
        last <= now
      )
        return;
      if (this.lastWrite.size >= 10_000) this.lastWrite.clear();
      this.lastWrite.set(id, now);
      this.lastUsedWrite = this.pool
        .query(
          `UPDATE api_tokens SET last_used_at = to_timestamp($2::double precision / 1000)
            WHERE id = $1 AND revoked_at IS NULL`,
          [id, now],
        )
        .then(
          () => undefined,
          () => {
            // Best effort: a failed write is retried on a later use.
            this.lastWrite.delete(id);
          },
        );
    } catch {
      // Never fails the request.
    }
  }
}
