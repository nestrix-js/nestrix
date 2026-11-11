/**
 * The admin login of the standalone server (backlog P5-04, "Settled design": admin login).
 *
 * Two layers protect everything but ingest and the login itself:
 *
 * 1. `AdminAuth.middleware()`, mounted by `configureApp` with `app.use()` before the body parsers
 *    and before any Nest route, so it sees every request, matched or not. It is **default deny**:
 *    only these raw paths pass without a session (anchored, case-insensitive, as Express routes):
 *    the OTLP receiver (`/v1/traces`), `/login`, `/login.css` and `/logout`. Every other path,
 *    `/`, `/assets/*`, `/api/v1/*` and any path a later controller adds, needs a valid session.
 * 2. `AdminAuthGuard`, a global Nest guard (`APP_GUARD`), lets a controller run only when the
 *    middleware stamped the request, and lets the session-free stamps reach only the controllers
 *    they were meant for. A controller reached without the middleware (an app built without
 *    `configureApp`) is refused.
 *
 * Without `NESTRIX_ADMIN_PASSWORD` every protected path answers 503 with a message saying how to
 * set it; ingest is unaffected. `Sec-Fetch-Site: cross-site` is refused on every path but ingest.
 * No response written here carries an `Access-Control-*` header.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { ServerConfig } from "../config.js";
import { SERVER_CONFIG } from "../config.module.js";
import { INGEST_TRACES_PATH_PATTERN } from "../ingest/tokens.js";
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

/** What the middleware decided for a request, read by `AdminAuthGuard`. */
export type AuthStamp = "ingest" | "login" | "session";
/** A private symbol: neither a client nor other code can forge the stamp by name. */
export const AUTH_STAMP = Symbol("nestrix-server:auth-stamp");
/** Session cookies looked at per request (duplicates beyond this are ignored). */
const MAX_SESSION_COOKIES = 8;

const LOGIN_ROUTE = /^\/login\/?$/i;
const LOGIN_CSS_ROUTE = /^\/login\.css$/i;
const LOGOUT_ROUTE = /^\/logout\/?$/i;
const API_PREFIX = /^\/api(?:\/|$)/i;
const SAFE_METHODS = new Set(["GET", "HEAD"]);

type Next = (error?: unknown) => void;

export function stampOf(req: unknown): AuthStamp | undefined {
  if (req === null || typeof req !== "object") return undefined;
  return (req as Record<symbol, AuthStamp | undefined>)[AUTH_STAMP];
}

function stamp(req: IncomingMessage, value: AuthStamp): void {
  (req as unknown as Record<symbol, AuthStamp>)[AUTH_STAMP] = value;
}

/** The start-up lines about the admin login (also used by tests). */
export function startupMessages(
  config: Pick<ServerConfig, "adminPassword" | "sessionSecretGenerated">,
): { warn: string[]; log: string[] } {
  const warn: string[] = [];
  const log: string[] = [];
  if (config.adminPassword === undefined) {
    warn.push(
      "NESTRIX_ADMIN_PASSWORD is not set: the dashboard (/) and the query API (/api/v1) answer 503 until it is set (at least 12 characters) and the server restarted. Trace ingest (/v1/traces) is not affected.",
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
  /** Replaceable in tests. */
  limiter = new LoginRateLimiter();
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
    return (req, res, next) => {
      let pass = false;
      try {
        pass = this.decide(req, res);
      } catch {
        pass = false;
        writeRaw(res, {
          status: 500,
          csp: UI_CSP,
          contentType: TEXT_TYPE,
          body: "Internal error.",
        });
      }
      if (pass) next();
    };
  }

  /** True to pass the request on; false when a response was written. */
  private decide(req: IncomingMessage, res: ServerResponse): boolean {
    const path = pathnameOf(req);
    if (INGEST_TRACES_PATH_PATTERN.test(path)) {
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
    if (
      LOGIN_ROUTE.test(path) ||
      LOGIN_CSS_ROUTE.test(path) ||
      LOGOUT_ROUTE.test(path)
    ) {
      stamp(req, "login");
      return true;
    }
    if (!this.passwordConfigured) {
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
