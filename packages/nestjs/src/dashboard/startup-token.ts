import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Dashboard secrets: the per-process startup token (D-46), the cookies that carry a secret after
 * the exchange at `<path>/auth?token=`, cookie parsing, and the startup log line. Pure functions,
 * except `getProcessStartupToken()`, which holds the one token of the process.
 *
 * Nothing here logs. Nothing here keeps a configured `auth.token` in plain text: the resolver
 * stores only digests (`secretDigests`), and a cookie value is derived from the token the request
 * presented, after it matched.
 */

/** Which secret a cookie carries. Part of the cookie name and of the derived cookie value. */
export type SecretKind = "startup" | "token";

/** SHA-256 digests of one secret. Neither digest admits anything by itself. */
export interface SecretDigests {
  /** `sha256(secret)`: compared with `sha256(candidate)` for `?token=` and `Authorization: Bearer`. */
  readonly tokenDigest: Buffer;
  /** `sha256(cookieValue)`: compared with `sha256(candidate)` for a cookie value. */
  readonly cookieDigest: Buffer;
}

/** The startup token of this process and its digests. `token` is printed once, in the log line. */
export interface StartupTokenSecret extends SecretDigests {
  /** 32 random bytes, base64url (43 characters). */
  readonly token: string;
}

const COOKIE_VALUE_LABEL = "nestrix.dashboard.cookie.v1";
const DIGEST_BYTES = 32;
/** Random per process, generated once like the startup token. Never logged or exported. */
const processSalt = randomBytes(DIGEST_BYTES).toString("base64url");
/** More `token` query parameters than this are ignored. */
export const MAX_CANDIDATES = 8;

/** SHA-256 of the UTF-8 bytes of `value`. */
export function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * The cookie value that stands for `secret` once it has been exchanged. Base64url, so it needs no
 * quoting or escaping whatever characters a configured token holds, and the browser never stores
 * the configured token itself. `kind` keeps a startup cookie from ever passing as a token cookie.
 */
export function deriveCookieValue(kind: SecretKind, secret: string): string {
  // The `token` cookie carries a secret that outlives the process (a configured `auth.token`), so
  // a per-process salt makes a leaked cookie useless after a restart. The startup token dies with
  // the process already.
  const salt = kind === "token" ? `\0${processSalt}` : "";
  return sha256(`${COOKIE_VALUE_LABEL}\0${kind}\0${secret}${salt}`).toString(
    "base64url",
  );
}

/** Both digests of `secret`. Computed once, at option resolution or token creation. */
export function secretDigests(kind: SecretKind, secret: string): SecretDigests {
  return {
    tokenDigest: sha256(secret),
    cookieDigest: sha256(deriveCookieValue(kind, secret)),
  };
}

/**
 * Constant-time check that `candidate` is the secret behind `expected` (a SHA-256 digest).
 * Both sides are 32-byte digests, so neither the comparison time nor an early length check reveals
 * the secret's length. Never throws: a non-string candidate or a malformed digest is `false`.
 */
export function matchesDigest(candidate: unknown, expected: Buffer): boolean {
  try {
    if (typeof candidate !== "string") return false;
    if (!Buffer.isBuffer(expected) || expected.length !== DIGEST_BYTES)
      return false;
    return timingSafeEqual(sha256(candidate), expected);
  } catch {
    return false;
  }
}

/**
 * A fresh startup token: 32 random bytes, base64url. `bytes` is for tests; anything but exactly
 * 32 bytes throws, so a short token cannot be created by mistake.
 */
export function createStartupToken(
  bytes: Buffer = randomBytes(DIGEST_BYTES),
): StartupTokenSecret {
  if (!Buffer.isBuffer(bytes) || bytes.length !== DIGEST_BYTES) {
    throw new Error("A Nestrix startup token needs exactly 32 random bytes");
  }
  const token = bytes.toString("base64url");
  return Object.freeze({ token, ...secretDigests("startup", token) });
}

let processToken: StartupTokenSecret | undefined;

/**
 * The startup token of this process, created on first call (P2-06 calls it at `onModuleInit`).
 * Several Nest applications in one process share it; their cookies still differ by port.
 */
export function getProcessStartupToken(): StartupTokenSecret {
  processToken ??= createStartupToken();
  return processToken;
}

/** Internal, for tests only. */
export function resetProcessStartupTokenForTests(): void {
  processToken = undefined;
}

function portLabel(localPort: unknown): string {
  return typeof localPort === "number" &&
    Number.isInteger(localPort) &&
    localPort > 0 &&
    localPort < 65536
    ? String(localPort)
    : "0";
}

/**
 * The cookie name for `kind` on the listener at `localPort` (the raw socket's `localPort`):
 * `nestrix_session_<port>` for the startup token, `nestrix_auth_<port>` for `auth: { token }`.
 *
 * Why the port: browsers do not isolate cookies by port, so two apps on `localhost:3000` and
 * `localhost:4000` with the same dashboard path would overwrite each other's cookie under one
 * name. The listener's own port is the thing that differs between them, cannot be set by the
 * client, and stays the same across restarts, so a restarted app replaces its stale cookie instead
 * of adding one more (a name derived from the per-process token would add a cookie per restart,
 * and watch-mode restarts would pile them up until the `Cookie` header outgrew the server's
 * header limit). The path needs no part in the name: the `Path` attribute already scopes it.
 * A socket without a numeric port (`inject()`-style fakes) uses `0`, consistently for the
 * exchange and later requests.
 */
export function cookieName(kind: SecretKind, localPort: unknown): string {
  return `${kind === "startup" ? "nestrix_session" : "nestrix_auth"}_${portLabel(localPort)}`;
}

/**
 * The `Set-Cookie` value for the exchange: `HttpOnly; SameSite=Strict; Path=<path>`, no
 * `Max-Age` or `Expires` (a session cookie). The caller decides `secure`: it is true when the
 * request came over TLS to this server (`socket.encrypted`), or in `enabled` mode when the request
 * is not local (see `access.ts`). Behind a TLS-terminating proxy in `auto` mode TLS cannot be
 * known and it is left off. `path` must be a resolved dashboard path (its character set has no `;`, `,` or space).
 */
export function serializeCookie(
  name: string,
  value: string,
  path: string,
  secure: boolean,
): string {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

/**
 * Every value of cookie `name` in a `Cookie` header, in order, with no cap (Node's header-size
 * limit bounds the work).
 * Pairs are split on `;`; names compare exactly (case-sensitive); spaces and tabs around names
 * and values are dropped; one pair of surrounding double quotes is removed; values are not
 * percent-decoded (Nestrix's values are base64url). An array (several `Cookie` headers) is read
 * as one header. Anything that is not a string yields `[]`. Never throws.
 */
export function getCookieValues(header: unknown, name: string): string[] {
  const out: string[] = [];
  try {
    const text = Array.isArray(header)
      ? header.filter((h) => typeof h === "string").join("; ")
      : header;
    if (typeof text !== "string" || text.length === 0) return out;
    for (const pair of text.split(";")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      if (pair.slice(0, eq).trim() !== name) continue;
      let value = pair.slice(eq + 1).trim();
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      out.push(value);
    }
  } catch {
    return [];
  }
  return out;
}

/** Whether any value of cookie `name` in `header` derives from the secret behind `cookieDigest`. */
export function cookieMatches(
  header: unknown,
  name: string,
  cookieDigest: Buffer,
): boolean {
  let matched = false;
  for (const value of getCookieValues(header, name)) {
    // No early exit: which duplicate matched is not worth a timing difference.
    if (matchesDigest(value, cookieDigest)) matched = true;
  }
  return matched;
}

/**
 * The credentials of an `Authorization: Bearer <token>` header, or `undefined`. The scheme is
 * case-insensitive (RFC 9110 §11.1); the token is everything after the whitespace that follows it,
 * with trailing whitespace removed. Only a string header counts (Node keeps the first of several).
 */
export function getBearerToken(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^bearer[ \t]+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  return token ? token : undefined;
}

/** The `token` query parameters of a request target (`raw.url`), at most `MAX_CANDIDATES`. */
export function getQueryTokens(url: unknown): string[] {
  try {
    if (typeof url !== "string") return [];
    const q = url.indexOf("?");
    if (q < 0) return [];
    return new URLSearchParams(url.slice(q + 1))
      .getAll("token")
      .slice(0, MAX_CANDIDATES);
  } catch {
    return [];
  }
}

export interface DashboardLinkInput {
  /** A resolved dashboard path, e.g. `/_nestrix`. */
  readonly path: string;
  /** The port the server listens on; `undefined` when `listen()` was not called (or on a pipe). */
  readonly port: number | undefined;
  /** The startup token, when `'auto'` mode uses one; `undefined` otherwise. */
  readonly startupToken: string | undefined;
}

/**
 * The one startup log line naming the dashboard. With a port and a startup token:
 * `Nestrix dashboard: http://localhost:<port><path>/auth?token=<token>`. Without a port the token
 * is not printed (there is nothing to open yet) and the line says the link needs a listening server.
 */
export function dashboardLinkLine(input: DashboardLinkInput): string {
  const { path, port, startupToken } = input;
  const hasPort =
    typeof port === "number" && Number.isInteger(port) && port > 0;
  if (hasPort) {
    return startupToken
      ? `Nestrix dashboard: http://localhost:${port}${path}/auth?token=${startupToken}`
      : `Nestrix dashboard: http://localhost:${port}${path}/`;
  }
  return startupToken
    ? `Nestrix dashboard: served at ${path}/ once the application listens; the startup-token link needs a listening server (call app.listen()).`
    : `Nestrix dashboard: served at ${path}/ once the application listens.`;
}
