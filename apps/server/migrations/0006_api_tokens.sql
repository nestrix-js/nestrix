-- Read-only API tokens for machine access to the query API (docs/backlog/phase-8.md P8-01, D-74).
-- The token itself is never stored: `hash` is the hex SHA-256 of the full token (`nxt_` + 43
-- base64url characters), `prefix` its first 8 characters for display. A revoked token keeps its
-- row (with `revoked_at`) so the list shows what was revoked and when.

CREATE TABLE api_tokens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  prefix text NOT NULL CHECK (prefix ~ '^nxt_[A-Za-z0-9_-]{4}$'),
  hash text NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Written at most once a minute per token.
  last_used_at timestamptz,
  revoked_at timestamptz
);
