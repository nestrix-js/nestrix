/**
 * The admin login of the standalone server (backlog P5-04, "Settled design": admin login).
 *
 * Two layers protect everything but ingest and the login itself:
 *
 * 1. `AdminAuth.middleware()`, mounted by `configureApp` with `app.use()` before the body parsers
 *    and before any Nest route, so it sees every request, matched or not. It is **default deny**:
 *    only these raw paths pass without a session (anchored, case-insensitive, as Express routes):
 *    the ingest-key routes (`INGEST_PATH_PATTERN`: `/v1/traces`, `/v1/logs`, and remote
 *    profiling's `/v1/nestrix/check-in`, `/v1/nestrix/profiles/:id` and `…/:id/failed`),
 *    `/login`, `/login.css` and `/logout`. Every other path,
 *    `/`, `/assets/*`, `/api/v1/*` and any path a later controller adds, needs a valid session.
 * 2. `AdminAuthGuard`, a global Nest guard (`APP_GUARD`), lets a controller run only when the
 *    middleware stamped the request, and lets the session-free stamps reach only the controllers
 *    they were meant for. A controller reached without the middleware (an app built without
 *    `configureApp`) is refused.
 *
 * Without `NESTRIX_ADMIN_PASSWORD` every protected path answers 503 with a message saying how to
 * set it; ingest is unaffected. `Sec-Fetch-Site: cross-site` is refused on every path but ingest.
 * No response written here carries an `Access-Control-*` header.
 *
 * API tokens (P8-01, `decideToken`): a request with `Authorization: Bearer nxt_…` is judged by
 * that token alone, whatever cookie it carries. It passes only as a `GET`/`HEAD` of a query-API
 * read route (`TOKEN_READ_ROUTE`) with a stored, unrevoked token, stamped `token`; everything else
 * with such a header (the UI, `/login`, token, alert and SLO routes, any write) answers 401. Ingest
 * is decided first and never looks at API tokens. Refused tokens count toward the login rate
 * limiter's global failure budget (within a per-client allowance), and while either is spent
 * further misses answer 429; valid tokens are never refused by it.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { ServerConfig } from "../config.js";
import { SERVER_CONFIG } from "../config.module.js";
import { INGEST_PATH_PATTERN } from "../ingest/tokens.js";
import {
  type ApiTokenVerifier,
  isApiTokenShape,
  type VerifiedApiToken,
} from "./api-tokens.js";
import {
  apiErrorBody,
  getCookieValues,
  HTML_TYPE,
  isCrossSite,
  isLoopbackPlainHttp,
  JSON_TYPE,
  LOGIN_CSP,
  originMatchesHost,
  pathnameOf,
  setSecurityHeaders,
  suppressCorsHeaders,
  TEXT_TYPE,
  UI_CSP,
  writeRaw,
} from "./http.js";
import { clientKey, LoginRateLimiter } from "./login-rate-limit.js";
import {
  LOGIN_CSS,
  LOGIN_PATH,
  type LoginNotice,
  loginPage,
  PASSWORD_NOT_SET_MESSAGE,
  passwordNotSetPage,
} from "./pages.js";
import {
  PROCESS_SALT,
  RevokedSessions,
  SESSION_TTL_SECONDS,
  sessionCookieName,
  sessionKey,
  sha256,
  signSession,
  type VerifiedSession,
  verifySession,
} from "./session.js";

/**
 * What the middleware decided for a request, read by `AdminAuthGuard` and the query guards.
 * `token`: a valid API token on a `GET`/`HEAD` of one of the query API's read routes (P8-01).
 */
export type AuthStamp = "ingest" | "login" | "session" | "token";
/** A private symbol: neither a client nor other code can forge the stamp by name. */
export const AUTH_STAMP = Symbol("nestrix-server:auth-stamp");
/** The id of the API token that authenticated a `token`-stamped request. */
export const AUTH_TOKEN_ID = Symbol("nestrix-server:auth-token-id");
/** Session cookies looked at per request (duplicates beyond this are ignored). */
const MAX_SESSION_COOKIES = 8;

const LOGIN_ROUTE = /^\/login\/?$/i;
const LOGIN_CSS_ROUTE = /^\/login\.css$/i;
const LOGOUT_ROUTE = /^\/logout\/?$/i;
const API_PREFIX = /^\/api(?:\/|$)/i;
const SAFE_METHODS = new Set(["GET", "HEAD"]);
/**
 * The only paths an API token may read (with `GET` or `HEAD`): the query API's read routes, as
 * Express routes them (case-insensitive, optional trailing slash), and remote profiling's reads
 * (P10-02: `instances`, `remote-profiles`, `remote-profiles/:id`, `remote-profiles/:id/download`;
 * starting a capture is a `POST`, which a token never passes). Not the alert, SLO or token
 * routes, not the UI, not ingest.
 */
export const TOKEN_READ_ROUTE =
  /^\/api\/v1\/(?:meta|traces(?:\/timeline)?|trace(?:\/logs)?|errors(?:\/groups|\/insights)?|routes(?:\/histogram|\/compare|\/explain)?|classes|queries|map|dependencies|overview|instances|remote-profiles(?:\/[^/]+(?:\/download)?)?)\/?$/i;
/** `Authorization: Bearer nxt_…`: the scheme case-insensitive (RFC 9110), the prefix exact. */
const BEARER_API_TOKEN = /^bearer +(nxt_\S*) *$/i;
const TOKEN_ONLY_READS = "API tokens can only read the query API.";
const TOKEN_REFUSED = "Invalid or revoked API token.";

type Next = (error?: unknown) => void;

export function stampOf(req: unknown): AuthStamp | undefined {
  if (req === null || typeof req !== "object") return undefined;
  return (req as Record<symbol, AuthStamp | undefined>)[AUTH_STAMP];
}

/** The id of the API token behind a `token` stamp. */
export function tokenIdOf(req: unknown): string | undefined {
  if (req === null || typeof req !== "object") return undefined;
  const id = (req as Record<symbol, unknown>)[AUTH_TOKEN_ID];
  return typeof id === "string" ? id : undefined;
}

function stamp(req: IncomingMessage, value: AuthStamp): void {
  (req as unknown as Record<symbol, AuthStamp>)[AUTH_STAMP] = value;
}

/**
 * What the request's `Authorization` header says about API tokens:
 * - `none`: no `Bearer nxt_…` credential (no header, or another scheme or credential, such as a
 *   proxy's Basic auth). The request is judged by its session as before.
 * - `token`: exactly one `Authorization` line, `Bearer nxt_…`. Judged by the token alone.
 * - `malformed`: a `Bearer nxt_…` line among several `Authorization` lines. Refused.
 *
 * Read from `rawHeaders`, since Node keeps only the first `Authorization` in `headers`.
 */
export type BearerCredential =
  | { kind: "none" }
  | { kind: "token"; value: string }
  | { kind: "malformed" };

export function bearerCredentialOf(req: IncomingMessage): BearerCredential {
  const lines: string[] = [];
  const raw = req.rawHeaders;
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (String(raw[i]).toLowerCase() === "authorization")
        lines.push(String(raw[i + 1]));
    }
  }
  let token: string | undefined;
  for (const line of lines) {
    const match = BEARER_API_TOKEN.exec(line.trim());
    if (match) token = match[1] as string;
  }
  if (token === undefined) return { kind: "none" };
  if (lines.length !== 1) return { kind: "malformed" };
  return { kind: "token", value: token };
}

/** The start-up lines about the admin login (also used by tests). */
export function startupMessages(
  config: Pick<ServerConfig, "adminPassword" | "sessionSecretGenerated">,
): { warn: string[]; log: string[] } {
  const warn: string[] = [];
  const log: string[] = [];
  if (config.adminPassword === undefined) {
    warn.push(
      "NESTRIX_ADMIN_PASSWORD is not set: the dashboard (/) and the query API (/api/v1) answer 503 until it is set (at least 12 characters) and the server restarted. Ingest (/v1/traces, /v1/logs) is not affected.",
    );
  } else if (config.sessionSecretGenerated) {
    log.push(
      "NESTRIX_SESSION_SECRET is not set: a random one is used, so admin sessions end when the server restarts.",
    );
  }
  return { warn, log };
}

@Injectable()
export class AdminAuth implements OnModuleInit {
  private readonly logger = new Logger("NestrixAdminAuth");
  private readonly passwordDigest: Buffer | undefined;
  private readonly key: Buffer | undefined;
  readonly revoked = new RevokedSessions();
  /** Set by `TokensModule`; without it every `Bearer nxt_…` request is refused. */
  private tokenVerifier: ApiTokenVerifier | undefined;
  /** Replaceable in tests. */
  limiter = new LoginRateLimiter();
  /**
   * Per-client allowance of refused API tokens (5 a minute, like `/login`). Only misses are
   * taken from it, so a client's valid token is never counted. Replaceable in tests.
   */
  tokenLimiter = new LoginRateLimiter();
  /** Seconds since the epoch. Replaceable in tests. */
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000);

  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {
    const password = config.adminPassword;
    this.passwordDigest = password === undefined ? undefined : sha256(password);
    this.key =
      password === undefined
        ? undefined
        : sessionKey(config.sessionSecret, password, PROCESS_SALT);
  }

  onModuleInit(): void {
    try {
      const { warn, log } = startupMessages(this.config);
      for (const line of warn) this.logger.warn(line);
      for (const line of log) this.logger.log(line);
    } catch {
      // Logging must not stop the server from starting.
    }
  }

  get passwordConfigured(): boolean {
    return this.key !== undefined;
  }

  /** Called once by `TokensModule` at start. */
  useTokenVerifier(verifier: ApiTokenVerifier): void {
    this.tokenVerifier = verifier;
  }

  /** The valid, unrevoked session among the request's session cookies, if any. Never throws. */
  sessionOf(req: IncomingMessage): VerifiedSession | undefined {
    try {
      const key = this.key;
      if (key === undefined) return undefined;
      const now = this.nowSeconds();
      let found: VerifiedSession | undefined;
      const values = getCookieValues(
        req.headers.cookie,
        sessionCookieName(req.socket?.localPort),
      );
      for (const value of values.slice(0, MAX_SESSION_COOKIES)) {
        const session = verifySession(key, value, now);
        if (found === undefined && session && !this.revoked.has(session.nonce))
          found = session;
      }
      return found;
    } catch {
      return undefined;
    }
  }

  /** The `app.use()` middleware. Every failure denies (500); it never passes a request on by mistake. */
  middleware(): (
    req: IncomingMessage,
    res: ServerResponse,
    next: Next,
  ) => void {
    const internalError = (res: ServerResponse) =>
      writeRaw(res, {
        status: 500,
        csp: UI_CSP,
        contentType: TEXT_TYPE,
        body: "Internal error.",
      });
    return (req, res, next) => {
      let decision: boolean | Promise<boolean> = false;
      try {
        decision = this.decide(req, res);
      } catch {
        decision = false;
        internalError(res);
      }
      if (decision === true) {
        next();
      } else if (decision !== false) {
        // An API token is checked against the database: pass on only once it was found. Nothing
        // here may leave a rejected promise unhandled (that would end the process).
        decision
          .then(
            (pass) => {
              if (!pass) return;
              try {
                next();
              } catch (error) {
                next(error);
              }
            },
            () => internalError(res),
          )
          .catch(() => internalError(res));
      }
    };
  }

  /** True to pass the request on; false when a response was written. */
  private decide(
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean | Promise<boolean> {
    const path = pathnameOf(req);
    if (INGEST_PATH_PATTERN.test(path)) {
      // Ingest (/v1/traces, /v1/logs, /v1/nestrix/*) keeps its own keys: an API token is not one
      // (the receiver and the instance routes check them).
      stamp(req, "ingest");
      return true;
    }
    setSecurityHeaders(res, UI_CSP);
    suppressCorsHeaders(res);
    const api = API_PREFIX.test(path);
    if (isCrossSite(req)) {
      this.refuse(
        res,
        api,
        403,
        "forbidden",
        "Cross-site requests are refused.",
      );
      return false;
    }
    const bearer = bearerCredentialOf(req);
    if (bearer.kind !== "none") {
      // Judged by the token alone, before the login paths and whatever session cookie came along.
      return this.decideToken(req, res, path, api, bearer);
    }
    if (
      LOGIN_ROUTE.test(path) ||
      LOGIN_CSS_ROUTE.test(path) ||
      LOGOUT_ROUTE.test(path)
    ) {
      stamp(req, "login");
      return true;
    }
    if (!this.passwordConfigured) {
      this.passwordNotSet(res, api);
      return false;
    }
    const method = (req.method ?? "").toUpperCase();
    if (!SAFE_METHODS.has(method) && !originMatchesHost(req)) {
      // A state-changing method needs a same-origin `Origin`, session or not (CSRF; a same-site
      // page on another port receives the SameSite=Strict cookie).
      this.refuse(res, api, 403, "forbidden", "Origin not allowed.");
      return false;
    }
    if (this.sessionOf(req) !== undefined) {
      stamp(req, "session");
      return true;
    }
    if (api) {
      writeRaw(res, {
        status: 401,
        csp: UI_CSP,
        contentType: JSON_TYPE,
        headers: { "www-authenticate": 'Cookie realm="nestrix"' },
        body: apiErrorBody("unauthorized", "Sign in at /login."),
      });
    } else if (SAFE_METHODS.has(method)) {
      writeRaw(res, {
        status: 303,
        csp: UI_CSP,
        headers: { location: LOGIN_PATH },
      });
    } else {
      writeRaw(res, {
        status: 401,
        csp: UI_CSP,
        contentType: TEXT_TYPE,
        body: "Sign in at /login.",
      });
    }
    return false;
  }

  private passwordNotSet(res: ServerResponse, api: boolean): void {
    if (api) {
      writeRaw(res, {
        status: 503,
        csp: UI_CSP,
        contentType: JSON_TYPE,
        body: apiErrorBody("unavailable", PASSWORD_NOT_SET_MESSAGE),
      });
    } else {
      writeRaw(res, {
        status: 503,
        csp: LOGIN_CSP,
        contentType: HTML_TYPE,
        body: passwordNotSetPage(),
      });
    }
  }

  /**
   * A token that is not valid: over this client's allowance of misses or with the global failure
   * budget spent -> 429 with `Retry-After` (neither counts again); otherwise 401, counted toward
   * the global budget. Valid tokens never reach here, so a lockout cannot refuse one.
   */
  private tokenMiss(req: IncomingMessage, res: ServerResponse, api: boolean) {
    const client = this.tokenLimiter.take(clientKey(req.socket?.remoteAddress));
    const decision = client.ok ? this.limiter.checkFailureBudget() : client;
    if (!decision.ok) {
      writeRaw(res, {
        status: 429,
        csp: UI_CSP,
        contentType: JSON_TYPE,
        headers: { "retry-after": String(decision.retryAfterSeconds) },
        body: apiErrorBody(
          "too_many_requests",
          "Too many failed sign-in or token attempts. Try again later.",
        ),
      });
      return;
    }
    this.limiter.recordFailure();
    this.refuseToken(res, api, TOKEN_REFUSED);
  }

  /**
   * A request carrying `Authorization: Bearer nxt_…` (P8-01). Order: admin password configured
   * (503; tokens are managed by the admin, so they work only while the admin login does) →
   * `GET`/`HEAD` on a query-API read route (401 otherwise; nothing is looked up or counted) →
   * token shape and a stored, unrevoked token with that hash → stamp `token` with the token's id.
   * A miss is counted against the client's own allowance and the login limiter's global failure
   * budget (401; 429 once either is spent). A valid token is checked first and never refused by
   * either limit.
   * A database failure answers 503 and counts nothing.
   */
  private decideToken(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    api: boolean,
    bearer: Exclude<BearerCredential, { kind: "none" }>,
  ): boolean | Promise<boolean> {
    if (!this.passwordConfigured) {
      this.passwordNotSet(res, api);
      return false;
    }
    const method = (req.method ?? "").toUpperCase();
    if (!SAFE_METHODS.has(method) || !TOKEN_READ_ROUTE.test(path)) {
      this.refuseToken(res, api, TOKEN_ONLY_READS);
      return false;
    }
    const verifier = this.tokenVerifier;
    if (
      bearer.kind !== "token" ||
      !isApiTokenShape(bearer.value) ||
      verifier === undefined
    ) {
      this.tokenMiss(req, res, api);
      return false;
    }
    let lookup: Promise<VerifiedApiToken | undefined>;
    try {
      lookup = verifier.verify(bearer.value);
    } catch (error) {
      lookup = Promise.reject(error);
    }
    return lookup.then(
      (found) => {
        if (found === undefined) {
          this.tokenMiss(req, res, api);
          return false;
        }
        stamp(req, "token");
        (req as unknown as Record<symbol, string>)[AUTH_TOKEN_ID] = found.id;
        return true;
      },
      () => {
        this.throttledWarn("API token lookup failed (database unavailable?)");
        writeRaw(res, {
          status: 503,
          csp: UI_CSP,
          contentType: JSON_TYPE,
          headers: { "retry-after": "5" },
          body: apiErrorBody(
            "unavailable",
            "The token could not be checked. Try again later.",
          ),
        });
        return false;
      },
    );
  }

  private lastWarnMs = 0;

  /** At most one line a minute; never includes the token. */
  private throttledWarn(message: string): void {
    try {
      const now = Date.now();
      if (now - this.lastWarnMs < 60_000) return;
      this.lastWarnMs = now;
      this.logger.warn(message);
    } catch {
      // Logging must not affect the response.
    }
  }

  private refuseToken(
    res: ServerResponse,
    api: boolean,
    message: string,
  ): void {
    writeRaw(res, {
      status: 401,
      csp: UI_CSP,
      contentType: api ? JSON_TYPE : TEXT_TYPE,
      headers: {
        "www-authenticate": 'Bearer realm="nestrix", error="invalid_token"',
      },
      body: api ? apiErrorBody("unauthorized", message) : message,
    });
  }

  private refuse(
    res: ServerResponse,
    api: boolean,
    status: number,
    code: string,
    message: string,
  ): void {
    writeRaw(res, {
      status,
      csp: UI_CSP,
      contentType: api ? JSON_TYPE : TEXT_TYPE,
      body: api ? apiErrorBody(code, message) : message,
    });
  }

  // ---- /login, /logout ---------------------------------------------------------------------

  private page(
    res: ServerResponse,
    status: number,
    body: string,
    headers?: Record<string, string>,
  ): void {
    writeRaw(res, {
      status,
      csp: LOGIN_CSP,
      contentType: HTML_TYPE,
      body,
      headers,
    });
  }

  private loginForm(
    res: ServerResponse,
    status: number,
    notice?: LoginNotice,
    headers?: Record<string, string>,
  ): void {
    this.page(res, status, loginPage(notice), headers);
  }

  /** `GET /login.css`. Served with or without a password, so the 503 page is styled too. */
  css(res: ServerResponse): void {
    writeRaw(res, {
      status: 200,
      csp: LOGIN_CSP,
      contentType: "text/css; charset=utf-8",
      body: LOGIN_CSS,
    });
  }

  /** `GET /login`: the form, the 503 page, or a redirect to `/` when already signed in. */
  showLogin(req: IncomingMessage, res: ServerResponse): void {
    try {
      if (!this.passwordConfigured) {
        this.page(res, 503, passwordNotSetPage());
        return;
      }
      if (this.sessionOf(req) !== undefined) {
        writeRaw(res, {
          status: 303,
          csp: LOGIN_CSP,
          headers: { location: "/" },
        });
        return;
      }
      this.loginForm(res, 200);
    } catch {
      writeRaw(res, {
        status: 500,
        csp: LOGIN_CSP,
        contentType: TEXT_TYPE,
        body: "Internal error.",
      });
    }
  }

  /**
   * `POST /login`. Order: password configured (503) → `Origin` matches `Host` (403) → rate limit
   * (429) → password, hashed on both sides and compared with `timingSafeEqual` (401) → session
   * cookie and `303 Location: /`. The redirect target is fixed: no open redirect.
   */
  login(req: IncomingMessage, res: ServerResponse): void {
    try {
      const digest = this.passwordDigest;
      const key = this.key;
      if (digest === undefined || key === undefined) {
        this.page(res, 503, passwordNotSetPage());
        return;
      }
      if (!originMatchesHost(req)) {
        this.loginForm(res, 403, "bad-origin");
        return;
      }
      const rate = this.limiter.take(clientKey(req.socket?.remoteAddress));
      if (!rate.ok) {
        this.loginForm(res, 429, "rate-limited", {
          "retry-after": String(rate.retryAfterSeconds),
        });
        return;
      }
      const body = (req as { body?: unknown }).body;
      const candidate =
        body !== null && typeof body === "object"
          ? (body as Record<string, unknown>).password
          : undefined;
      const given = sha256(typeof candidate === "string" ? candidate : "");
      const matches = timingSafeEqual(given, digest);
      if (!matches || typeof candidate !== "string") {
        this.limiter.recordFailure();
        this.loginForm(res, 401, "wrong-password");
        return;
      }
      const expires = this.nowSeconds() + SESSION_TTL_SECONDS;
      const token = signSession(key, expires);
      writeRaw(res, {
        status: 303,
        csp: LOGIN_CSP,
        headers: {
          location: "/",
          "set-cookie": this.cookie(req, token, SESSION_TTL_SECONDS),
        },
      });
    } catch {
      writeRaw(res, {
        status: 500,
        csp: LOGIN_CSP,
        contentType: TEXT_TYPE,
        body: "Internal error.",
      });
    }
  }

  /**
   * `POST /logout`: `Origin` must match (403 otherwise, so another page cannot sign the admin
   * out); the session, if valid, is revoked until it expires; the cookie is cleared; `303` to
   * `/login`.
   */
  logout(req: IncomingMessage, res: ServerResponse): void {
    try {
      if (!originMatchesHost(req)) {
        writeRaw(res, {
          status: 403,
          csp: LOGIN_CSP,
          contentType: TEXT_TYPE,
          body: "Origin not allowed.",
        });
        return;
      }
      const session = this.sessionOf(req);
      if (session) this.revoked.revoke(session, this.nowSeconds());
      writeRaw(res, {
        status: 303,
        csp: LOGIN_CSP,
        headers: {
          location: LOGIN_PATH,
          "set-cookie": this.cookie(req, "", 0),
        },
      });
    } catch {
      writeRaw(res, {
        status: 500,
        csp: LOGIN_CSP,
        contentType: TEXT_TYPE,
        body: "Internal error.",
      });
    }
  }

  /** `HttpOnly; SameSite=Strict; Path=/`, `Max-Age`, and `Secure` unless loopback plain HTTP. */
  private cookie(req: IncomingMessage, value: string, maxAge: number): string {
    const secure = !isLoopbackPlainHttp(req);
    return `${sessionCookieName(req.socket?.localPort)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  }
}
