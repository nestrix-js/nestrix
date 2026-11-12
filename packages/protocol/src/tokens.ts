/**
 * API tokens of the standalone server (`/api/v1/tokens`, docs/backlog/phase-8.md P8-01, D-74).
 * Types only: this file adds no runtime export.
 *
 * A token is `nxt_` followed by 43 base64url characters (32 random bytes). It is shown once, in
 * the answer to `POST /api/v1/tokens`; the server keeps only its SHA-256 hash and a display prefix.
 * Sent as `Authorization: Bearer nxt_…`, it reads the query API (`GET`/`HEAD` on meta, traces,
 * trace, errors, routes, classes, map) and nothing else. Only a signed-in session manages tokens.
 */

/** A stored token, without its secret. */
export interface ApiToken {
  /** Decimal string of the numeric id. */
  id: string;
  name: string;
  /** The first 8 characters of the token (`nxt_` and 4 more), to tell tokens apart. */
  prefix: string;
  createdAtUnixMs: number;
  /** Updated at most once a minute; `null` before the first use. */
  lastUsedAtUnixMs: number | null;
  /** `null` while the token works. */
  revokedAtUnixMs: number | null;
}

/** `POST /api/v1/tokens`. Unknown fields are refused (400). */
export interface ApiTokenCreate {
  /** 1 to 100 characters, no control characters. */
  name: string;
}

/** The answer to `POST /api/v1/tokens` (201): the only time the secret is ever sent. */
export interface ApiTokenCreateResponse {
  token: ApiToken;
  /** The full token, `nxt_…`. Not stored by the server; copy it now. */
  secret: string;
}

/** `GET /api/v1/tokens`: newest first, revoked ones included (marked by `revokedAtUnixMs`). */
export interface ApiTokenListResponse {
  tokens: ApiToken[];
}
