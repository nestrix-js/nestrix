-- Admin sessions shared by every server instance (issue #31, D-96; src/auth/session-store.ts).
--
-- `admin_session_revocations`: sessions ended by `/logout`, by the session cookie's nonce (16
-- random bytes, base64url), kept until the session expires. The cookie is signed with a key
-- derived from NESTRIX_SESSION_SECRET and the admin password, which are not stored here, so a
-- nonce alone cannot be turned into a cookie. Expired rows are deleted when a new one is written.
CREATE TABLE admin_session_revocations (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[A-Za-z0-9_-]{22}$'),
  expires_at timestamptz NOT NULL
);
CREATE INDEX admin_session_revocations_expires_at ON admin_session_revocations (expires_at);

-- The login limiter's per-client window: the times of the attempts counted in the last window
-- (at most the per-client limit of them). `taken` says whether the last statement counted an
-- attempt (read back with RETURNING). Rows whose last attempt left the window are deleted at most
-- once a minute per instance. `client` is a limiter key (an IPv4 address or an IPv6 /64), never a
-- header value.
CREATE TABLE admin_login_clients (
  client text PRIMARY KEY CHECK (char_length(client) BETWEEN 1 AND 100),
  attempts timestamptz[] NOT NULL,
  taken boolean NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX admin_login_clients_updated_at ON admin_login_clients (updated_at);

-- The global budget of failed logins and refused API tokens: one row, the times of the slots
-- taken in the last window (at most the budget of them). A /login attempt reserves a slot before
-- the password check, under this row's lock, and releases it on a right password; `reserved` says
-- whether the last statement took a slot (read back with RETURNING).
CREATE TABLE admin_login_failures (
  id smallint PRIMARY KEY CHECK (id = 1),
  failures timestamptz[] NOT NULL,
  reserved boolean NOT NULL
);
