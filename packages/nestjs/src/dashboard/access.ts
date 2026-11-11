import type { ResolvedUi, ResolvedUiAuth } from "../resolve-options.js";
import {
  cookieMatches,
  cookieName,
  deriveCookieValue,
  getBearerToken,
  getQueryTokens,
  matchesDigest,
  type SecretKind,
  type StartupTokenSecret,
  serializeCookie,
} from "./startup-token.js";

/**
 * Who may see the dashboard (architecture §4.7, D-30, D-46; backlog P2, "Public API").
 *
 * Everything here reads the raw socket and the raw headers of `(req.raw ?? req)`, never `req.ip`,
 * `req.hostname` or `httpAdapter.getRequestHostname()`: those follow client-supplied forwarding
 * headers when the host trusts proxies (spike P0-S5 Q7). Nothing here writes a response; P2-06
 * turns a decision into one.
 *
 * Fail closed: every exported function catches everything, and an internal error is a denial.
 */

/** Serve the request. */
export interface Allow {
  readonly outcome: "allow";
}
/** Answer `404` with an empty body, so the dashboard's existence is not revealed. */
export interface Deny404 {
  readonly outcome: "deny";
  readonly status: 404;
}
/**
 * `'auto'` mode only: the request passed the loopback checks but lacks the startup-token cookie.
 * Answer `403` with a page (or a JSON `ApiError` for the API) saying to open the link Nestrix
 * logged at startup.
 */
export interface NeedToken403 {
  readonly outcome: "need-token";
  readonly status: 403;
}
export type AccessDecision = Allow | Deny404 | NeedToken403;

/** The exchange succeeded or was not needed: answer `303` with `Location` and, if set, `Set-Cookie`. */
export interface ExchangeRedirect {
  readonly outcome: "redirect";
  readonly status: 303;
  /** `<path>/`, so the token leaves the address bar. */
  readonly location: string;
  /** The `Set-Cookie` header value, or `undefined` when no secret was exchanged. */
  readonly setCookie: string | undefined;
}
export type ExchangeDecision = ExchangeRedirect | Deny404 | NeedToken403;

export const ALLOW: Allow = Object.freeze({ outcome: "allow" });
export const DENY: Deny404 = Object.freeze({ outcome: "deny", status: 404 });
export const NEED_TOKEN: NeedToken403 = Object.freeze({
  outcome: "need-token",
  status: 403,
});

/** The parts of a raw request (`IncomingMessage`) the rules read. All optional: fakes exist. */
export interface RawRequestLike {
  readonly socket?: {
    readonly remoteAddress?: unknown;
    readonly localPort?: unknown;
    readonly encrypted?: unknown;
  } | null;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly rawHeaders?: unknown;
  readonly url?: unknown;
}

/** Headers whose presence, with any value (empty included), means the request was forwarded. */
export const FORWARDING_HEADERS = Object.freeze([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "via",
] as const);

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_LOOPBACK = new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
const LOOPBACK_HOST = new RegExp(
  `^(?:localhost|127\\.${OCTET}\\.${OCTET}\\.${OCTET}|\\[::1\\])(?::(\\d{1,5}))?$`,
  "i",
);

/**
 * `(request.raw ?? request)`: Fastify's raw `IncomingMessage`, or the request itself on Express
 * and platform-node (both are `IncomingMessage`s). `undefined` for a non-object.
 */
export function rawRequestOf(request: unknown): RawRequestLike | undefined {
  if (request === null || typeof request !== "object") return undefined;
  const inner = (request as { raw?: unknown }).raw;
  if (
    inner !== null &&
    typeof inner === "object" &&
    typeof (inner as { headers?: unknown }).headers === "object"
  ) {
    return inner as RawRequestLike;
  }
  return request as RawRequestLike;
}

/**
 * A socket peer address in `127.0.0.0/8`, `::1` or `::ffff:127.0.0.0/104`, in the canonical form
 * Node reports (dotted decimal without leading zeros). Other spellings of the same addresses
 * (`0:0:0:0:0:0:0:1`, `::ffff:7f00:1`, a zone id) are not loopback here: fail closed.
 */
export function isLoopbackAddress(address: unknown): boolean {
  if (typeof address !== "string") return false;
  if (address === "::1") return true;
  const lower = address.toLowerCase();
  const v4 = lower.startsWith("::ffff:") ? lower.slice(7) : lower;
  return IPV4_LOOPBACK.test(v4);
}

/**
 * A `Host` value naming a loopback host: `localhost`, `127.x.y.z` or `[::1]` (case-insensitive),
 * optionally with a port of 1 to 5 digits up to 65535. Anything else is not: `*.localhost`,
 * `localhost.`, other IPv6 spellings, userinfo, an empty port, an empty value.
 */
export function isLoopbackHost(host: unknown): boolean {
  if (typeof host !== "string") return false;
  const match = LOOPBACK_HOST.exec(host);
  if (!match) return false;
  const port = match[1];
  return port === undefined || Number(port) <= 65535;
}

function headerNamesInRaw(rawHeaders: unknown): string[] {
  const names: string[] = [];
  if (!Array.isArray(rawHeaders)) return names;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    if (typeof name === "string") names.push(name.toLowerCase());
  }
  return names;
}

/**
 * The per-request local-only rule of `ui: 'auto'` (architecture §4.7). All must hold:
 * - the socket peer is loopback (`isLoopbackAddress`);
 * - `Host` is present and loopback (`isLoopbackHost`), and so is every `Host` line on the wire
 *   (`rawHeaders`): Node accepts a request with two `Host` headers and keeps only the first in
 *   `headers`, so `Host: localhost` then `Host: evil.example` would otherwise pass. An HTTP/2
 *   `:authority`, when present, must be loopback too;
 * - none of `FORWARDING_HEADERS` is present, in `headers` or on the wire.
 * Never throws; a request it cannot read is not local.
 */
export function isLocalRequest(raw: RawRequestLike | undefined): boolean {
  try {
    if (!raw) return false;
    if (!isLoopbackAddress(raw.socket?.remoteAddress)) return false;
    const headers = raw.headers;
    if (!headers || typeof headers !== "object") return false;
    if (!isLoopbackHost(headers.host)) return false;
    const authority = headers[":authority"];
    if (authority !== undefined && !isLoopbackHost(authority)) return false;
    for (const name of FORWARDING_HEADERS) {
      if (headers[name] !== undefined) return false;
    }
    const rawHeaders = raw.rawHeaders;
    if (Array.isArray(rawHeaders)) {
      const names = headerNamesInRaw(rawHeaders);
      for (let i = 0; i < names.length; i++) {
        const name = names[i] as string;
        if ((FORWARDING_HEADERS as readonly string[]).includes(name))
          return false;
        if (name === "host" && !isLoopbackHost(rawHeaders[i * 2 + 1]))
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the browser says the request comes from another site (`Sec-Fetch-Site: cross-site`),
 * denied in every mode (D-30). Case-insensitive; with several headers (Node joins them with
 * `, `), any `cross-site` counts. Never throws; an unreadable request counts as cross-site.
 */
export function isCrossSite(raw: RawRequestLike | undefined): boolean {
  try {
    const value = raw?.headers?.["sec-fetch-site"];
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (typeof v !== "string") continue;
      for (const part of v.split(",")) {
        if (part.trim().toLowerCase() === "cross-site") return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

function hasCookieFor(
  raw: RawRequestLike,
  kind: SecretKind,
  cookieDigest: Buffer,
): boolean {
  return cookieMatches(
    raw.headers?.cookie,
    cookieName(kind, raw.socket?.localPort),
    cookieDigest,
  );
}

/** `auth` only. Called after the cheap checks; `authorize` last. Never rejects. */
async function passesAuth(
  request: unknown,
  raw: RawRequestLike,
  auth: ResolvedUiAuth,
): Promise<boolean> {
  try {
    if (auth.kind === "token") {
      // Header and cookie are both checked, without an early exit between them.
      const byHeader = matchesDigest(
        getBearerToken(raw.headers?.authorization),
        auth.tokenDigest,
      );
      const byCookie = hasCookieFor(raw, "token", auth.cookieDigest);
      return byHeader || byCookie;
    }
    const result = await auth.authorize.call(auth.thisArg, request);
    return result === true;
  } catch {
    return false;
  }
}

/**
 * Decides one dashboard request. `request` is what the route handler received (Fastify's
 * `Request`, Express's `req`, platform-node's `NodeRequest`); the rules read `rawRequestOf(request)`,
 * and `authorize` receives `request` itself. `startup` is the process's startup token
 * (`getProcessStartupToken()`), needed when `ui` is `'auto'` with `startupToken: true`.
 *
 * Order, cheapest first:
 * 1. `Sec-Fetch-Site: cross-site` → `DENY`, every mode.
 * 2. `'auto'`: not `isLocalRequest` → `DENY`.
 * 3. `'auto'` with `startupToken`: no startup cookie of this listener that matches → `NEED_TOKEN`.
 * 4. `auth`, if any (always in `'enabled'`): `{ token }` by `Authorization: Bearer` or the token
 *    cookie; `{ authorize }` awaited, and only `true` allows. Failing → `DENY`.
 * 5. `ALLOW`.
 *
 * `ui` off, a missing `startup` where one is needed, or any internal error → `DENY`.
 * Never throws and never rejects. A never-settling `authorize` leaves the promise pending.
 */
export async function checkAccess(
  request: unknown,
  ui: ResolvedUi,
  startup: StartupTokenSecret | undefined,
): Promise<AccessDecision> {
  try {
    if (ui.mode === "off") return DENY;
    const raw = rawRequestOf(request);
    if (!raw || isCrossSite(raw)) return DENY;
    if (ui.mode === "auto") {
      if (!isLocalRequest(raw)) return DENY;
      if (ui.startupToken) {
        if (!startup) return DENY;
        if (!hasCookieFor(raw, "startup", startup.cookieDigest))
          return NEED_TOKEN;
      }
    }
    if (ui.auth && !(await passesAuth(request, raw, ui.auth))) return DENY;
    return ALLOW;
  } catch {
    return DENY;
  }
}

function firstMatch(candidates: string[], digest: Buffer): string | undefined {
  let found: string | undefined;
  for (const c of candidates) {
    if (found === undefined && matchesDigest(c, digest)) found = c;
  }
  return found;
}

/**
 * Decides `GET <path>/auth?token=<token>`, the exchange of a secret for an HttpOnly cookie.
 * Same arguments as `checkAccess`.
 *
 * 1. `Sec-Fetch-Site: cross-site` → `DENY`; in `'auto'`, not `isLocalRequest` → `DENY`. These run
 *    before any token is looked at.
 * 2. A `token` query value that is the startup token (`'auto'` with `startupToken`) → redirect with
 *    `Set-Cookie: nestrix_session_<port>=…`; else one that is `auth.token` → redirect with
 *    `Set-Cookie: nestrix_auth_<port>=…`. Compared in constant time.
 * 3. Otherwise the request is decided as `checkAccess` decides it: `ALLOW` becomes a redirect
 *    without a cookie (already signed in, or nothing to exchange), and `NEED_TOKEN` / `DENY` are
 *    returned as they are (a stale startup link in `'auto'` gets the 403 page).
 *
 * Setting a cookie admits nothing by itself: every later request still goes through `checkAccess`,
 * so `authorize` and the loopback rules apply there. Never throws and never rejects.
 */
export async function decideTokenExchange(
  request: unknown,
  ui: ResolvedUi,
  startup: StartupTokenSecret | undefined,
): Promise<ExchangeDecision> {
  try {
    if (ui.mode === "off") return DENY;
    const raw = rawRequestOf(request);
    if (!raw || isCrossSite(raw)) return DENY;
    if (ui.mode === "auto" && !isLocalRequest(raw)) return DENY;

    const location = `${ui.path}/`;
    const candidates = getQueryTokens(raw.url);
    const port = raw.socket?.localPort;
    // `'enabled'` serves any environment, so the cookie is `Secure` unless the request is local
    // (a browser sends `Secure` cookies to `http://localhost`); `'auto'` keeps the TLS-only rule.
    const secure =
      raw.socket?.encrypted === true ||
      (ui.mode === "enabled" && !isLocalRequest(raw));
    const redirect = (kind: SecretKind, secret: string): ExchangeRedirect =>
      Object.freeze({
        outcome: "redirect",
        status: 303,
        location,
        setCookie: serializeCookie(
          cookieName(kind, port),
          deriveCookieValue(kind, secret),
          ui.path,
          secure,
        ),
      });

    if (candidates.length > 0) {
      if (ui.mode === "auto" && ui.startupToken && startup) {
        const match = firstMatch(candidates, startup.tokenDigest);
        if (match !== undefined) return redirect("startup", match);
      }
      if (ui.auth?.kind === "token") {
        const match = firstMatch(candidates, ui.auth.tokenDigest);
        if (match !== undefined) return redirect("token", match);
      }
    }

    const access = await checkAccess(request, ui, startup);
    if (access.outcome !== "allow") return access;
    return Object.freeze({
      outcome: "redirect",
      status: 303,
      location,
      setCookie: undefined,
    });
  } catch {
    return DENY;
  }
}
