-- Dashboard users and the audit log (issue #34, D-104; src/auth/users.ts, src/auth/audit.ts).
--
-- `dashboard_users`: one row per (issuer, subject), created by the user's first OIDC sign-in and
-- updated by every later one. `role` NULL means the last sign-in was refused by the role mapping:
-- such a user has no access, and every open session of theirs is refused at its next request
-- (sessions read the role on every request). `sessions_valid_after` is set when a sign-in is
-- refused: sessions issued at or before it stay refused if the user is added back. Email and name
-- are what the identity provider sent, for display only; they are never used to decide access.
CREATE TABLE dashboard_users (
  id bigserial PRIMARY KEY,
  issuer text NOT NULL CHECK (char_length(issuer) BETWEEN 1 AND 2048),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  email text CHECK (char_length(email) <= 320),
  name text CHECK (char_length(name) <= 200),
  role text CHECK (role IN ('admin', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  sessions_valid_after timestamptz,
  UNIQUE (issuer, subject)
);

-- `audit_log`: sign-ins (and failed ones, with a reason code), sign-outs, and every change to alert
-- rules, SLOs and API tokens and every remote CPU capture started, with who, when and the client
-- address. Rows older than NESTRIX_RETENTION_DAYS are deleted at most once an hour per instance.
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_kind text NOT NULL CHECK (actor_kind IN ('password', 'oidc', 'anonymous')),
  actor_label text NOT NULL CHECK (char_length(actor_label) BETWEEN 1 AND 320),
  actor_user_id bigint,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 64),
  target text CHECK (char_length(target) <= 64),
  outcome text NOT NULL CHECK (outcome IN ('ok', 'failed')),
  detail text CHECK (char_length(detail) <= 64),
  client_address text CHECK (char_length(client_address) <= 64)
);
CREATE INDEX audit_log_at ON audit_log (at);
