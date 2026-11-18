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
 *
 * Several instances (issue #31, D-96): a session cookie is signed with a key from
 * `NESTRIX_SESSION_SECRET` and the password only, so any instance with both accepts it, also after
 * a restart. Logout revocations, the per-client `/login` window and the global failure budget are
 * kept in PostgreSQL (`SessionStoreModule`, session-store.ts) and read on every check, so a logout
 * on one instance is refused by the next request on any other. When the store cannot answer the
 * server fails closed: a request with a validly signed cookie answers 503 (not 401: signing in
 * again would not help), `POST /login` answers 503 without checking the password, `/logout` answers
 * 503 and keeps the cookie, a token miss answers 503. The limiters key on `clientOf`: the socket
 * peer, or the `X-Forwarded-For` client when the peer is a `NESTRIX_TRUSTED_PROXIES` range.
 *
 * Users and roles (issue #34, D-104): with `NESTRIX_OIDC_ISSUER` set, `/login/oidc` starts an OIDC
 * sign-in (code flow, PKCE S256, `state`, `nonce`; oidc.ts) and `/login/oidc/callback` finishes it:
 * the callback goes through the login limiter like `POST /login`, the ID token is verified, the
 * role claim is mapped to `admin` or `viewer` (or refused), the user is upserted in
 * `dashboard_users`, and a `v2` session cookie carrying the user id is set (session.ts). Each
 * request with a `v2` cookie reads the user's role from the store (fail closed), so a role change
 * or a refused sign-in applies to every open session at its next request. A viewer's request
 * with any method but `GET`/`HEAD` answers 403 here, before any route. The admin password stays
 * as the break-glass admin (`v1` cookies, unchanged) unless `NESTRIX_ADMIN_PASSWORD_LOGIN=false`,
 * which also refuses existing `v1` cookies. Sign-ins, failed sign-ins and sign-outs are written to
 * the audit log (audit.ts).
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  Optional,
} from "@nestjs/common";
import type { ServerConfig } from "../config.js";
import { SERVER_CONFIG } from "../config.module.js";
import { INGEST_PATH_PATTERN } from "../ingest/tokens.js";
import {
  type ApiTokenVerifier,
  isApiTokenShape,
  type VerifiedApiToken,
} from "./api-tokens.js";
import { type AuditActor, AuditLog } from "./audit.js";
import { clientAddressOf } from "./client-address.js";
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
import {
  clientKey,
  type LoginLimiter,
  type LoginRateDecision,
  LoginRateLimiter,
  type LoginTake,
} from "./login-rate-limit.js";
import type { Role } from "./oidc.js";
import {
  claimValues,
  OidcClient,
  OidcError,
  type OidcFailure,
  randomToken,
  roleFor,
  safeEqual,
} from "./oidc.js";
import {
  LOGIN_CSS,
  LOGIN_PATH,
  type LoginNotice,
  type LoginOptions,
  loginPage,
  OIDC_START_PATH,
  PASSWORD_NOT_SET_MESSAGE,
  passwordNotSetPage,
  signedInPage,
} from "./pages.js";
import {
  PASSWORD_PRINCIPAL,
  type Principal,
  stampPrincipal,
  TOKEN_PRINCIPAL,
} from "./principal.js";
import {
  MemorySessionRevocations,
  oidcSessionKey,
  PENDING_TTL_SECONDS,
  pendingCookieName,
  pendingKey,
  RevokedSessions,
  SESSION_TTL_SECONDS,
  type SessionRevocations,
  sessionCookieName,
  sessionKey,
  sha256,
  signPending,
  signSession,
  signUserSession,
  type VerifiedSession,
  type VerifiedUserSession,
  verifyPending,
  verifySession,
  verifyUserSession,
} from "./session.js";
import { MemoryUserStore, type UserStore } from "./users.js";

/**
 * What `sessionOf` found: a valid, unrevoked session; none; or `unavailable` when the revocation
 * store could not answer for a validly signed cookie (the request is then refused, D-96).
 */
export type SessionLookup =
  | {
      readonly status: "valid";
      readonly session: VerifiedSession;
      readonly principal: Principal;
    }
  | { readonly status: "none" }
  | { readonly status: "unavailable" };
const NO_SESSION: SessionLookup = Object.freeze({ status: "none" });
const SESSION_UNAVAILABLE: SessionLookup = Object.freeze({
  status: "unavailable",
});

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
/** `/login/oidc` and `/login/oidc/callback` (issue #34). */
const OIDC_START_ROUTE = /^\/login\/oidc\/?$/i;
const OIDC_CALLBACK_ROUTE = /^\/login\/oidc\/callback\/?$/i;
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

/** A validly signed session cookie, before the store was asked. */
type Candidate =
  | { readonly kind: "password"; readonly session: VerifiedSession }
  | { readonly kind: "oidc"; readonly session: VerifiedUserSession };

/** The start-up lines about the admin login (also used by tests). */
export function startupMessages(
  config: Pick<ServerConfig, "adminPassword" | "sessionSecretGenerated"> &
    Partial<Pick<ServerConfig, "oidc" | "passwordLogin">>,
): { warn: string[]; log: string[] } {
  const warn: string[] = [];
  const log: string[] = [];
  if (config.oidc !== undefined) {
    log.push(
      `OIDC sign-in is on (issuer ${config.oidc.issuer}); ${config.passwordLogin === false || config.adminPassword === undefined ? "the admin password does not sign in" : "the admin password signs in as the break-glass admin"}.`,
    );
    if (config.sessionSecretGenerated) {
      log.push(
        "NESTRIX_SESSION_SECRET is not set: a random one is used, so sessions end when the server restarts and other server instances do not accept them.",
      );
    }
  } else if (config.adminPassword === undefined) {
    warn.push(
      "NESTRIX_ADMIN_PASSWORD is not set: the dashboard (/) and the query API (/api/v1) answer 503 until it is set (at least 12 characters) and the server restarted. Ingest (/v1/traces, /v1/logs) is not affected.",
    );
  } else if (config.sessionSecretGenerated) {
    log.push(
      "NESTRIX_SESSION_SECRET is not set: a random one is used, so admin sessions end when the server restarts and other server instances do not accept them.",
    );
  }
  return { warn, log };
}

@Injectable()
export class AdminAuth implements OnModuleInit {
  private readonly logger = new Logger("NestrixAdminAuth");
  private readonly passwordDigest: Buffer | undefined;
  /** The `v1` (break-glass admin) key; `undefined` without a password or with password login off. */
  private readonly key: Buffer | undefined;
  /** The `v2` (OIDC user) key; `undefined` without OIDC (issue #34). */
  private readonly userKey: Buffer | undefined;
  private readonly pendingKey: Buffer;
  /** The OIDC relying party; replaceable in tests (its `fetch`). */
  oidc: OidcClient | undefined;
  /**
   * Where logout revocations live. In-process until `SessionStoreModule` hands over the
   * PostgreSQL store at start (the server always does; only the receiver-only test app keeps this).
   */
  private revocations: SessionRevocations = new MemorySessionRevocations(() =>
    this.nowSeconds(),
  );
  /** Dashboard users (OIDC). In-process until `SessionStoreModule` hands over PostgreSQL. */
  private users: UserStore = new MemoryUserStore();
  /** Revocations this instance has already seen (never stale: a revocation outlives its session). */
  readonly revokedSeen = new RevokedSessions();
  /** Set by `TokensModule`; without it every `Bearer nxt_…` request is refused. */
  private tokenVerifier: ApiTokenVerifier | undefined;
  /**
   * The `/login` limiter and the global failure budget. In-process until `SessionStoreModule`
   * hands over the PostgreSQL limiter shared by every instance (D-96). Replaceable in tests.
   */
  limiter: LoginLimiter = new LoginRateLimiter();
  /** Seconds since the epoch. Replaceable in tests. */
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000);
  private readonly audit: AuditLog;

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @Optional() audit?: AuditLog,
  ) {
    this.audit = audit ?? new AuditLog();
    const password = config.adminPassword;
    const passwordLogin = config.passwordLogin !== false;
    this.passwordDigest =
      password === undefined || !passwordLogin ? undefined : sha256(password);
    this.key =
      password === undefined || !passwordLogin
        ? undefined
        : sessionKey(config.sessionSecret, password);
    const oidc = config.oidc;
    this.userKey =
      oidc === undefined
        ? undefined
        : oidcSessionKey(config.sessionSecret, oidc.issuer, oidc.clientId);
    this.pendingKey = pendingKey(config.sessionSecret);
    this.oidc = oidc === undefined ? undefined : new OidcClient(oidc);
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

  /** The admin password signs in (set, and `NESTRIX_ADMIN_PASSWORD_LOGIN` not `false`). */
  get passwordConfigured(): boolean {
    return this.key !== undefined;
  }

  /** Some way to sign in exists: the password or OIDC. Without one, the UI and API answer 503. */
  get loginConfigured(): boolean {
    return this.key !== undefined || this.userKey !== undefined;
  }

  private get loginOptions(): LoginOptions {
    return { password: this.passwordConfigured, oidc: this.oidc !== undefined };
  }

  /** Called once by `TokensModule` at start. */
  useTokenVerifier(verifier: ApiTokenVerifier): void {
    this.tokenVerifier = verifier;
  }

  /** Called once by `SessionStoreModule` at start: the stores every instance shares (D-96). */
  useSharedState(
    revocations: SessionRevocations,
    limiter: LoginLimiter,
    users?: UserStore,
  ): void {
    this.revocations = revocations;
    this.limiter = limiter;
    if (users !== undefined) this.users = users;
  }

  /** The client address the limiters key on (`NESTRIX_TRUSTED_PROXIES`, D-96). */
  private clientOf(req: IncomingMessage): string {
    return clientKey(clientAddressOf(req, this.config.trustedProxies));
  }

  /** The client address written to the audit log. */
  private addressOf(req: IncomingMessage): string | undefined {
    try {
      return clientAddressOf(req, this.config.trustedProxies);
    } catch {
      return undefined;
    }
  }

  /**
   * The validly signed, unexpired sessions among the request's session cookies, without asking
   * the stores; duplicates dropped. Throws only on a fault (callers catch).
   */
  private signedSessions(req: IncomingMessage): Candidate[] {
    const key = this.key;
    const userKey = this.userKey;
    if (key === undefined && userKey === undefined) return [];
    const now = this.nowSeconds();
    const values = getCookieValues(
      req.headers.cookie,
      sessionCookieName(req.socket?.localPort),
    );
    const found = new Map<string, Candidate>();
    const lifetime = this.config.oidc?.sessionSeconds ?? 0;
    for (const value of values.slice(0, MAX_SESSION_COOKIES)) {
      if (value.startsWith("v2.")) {
        const session =
          userKey === undefined
            ? undefined
            : verifyUserSession(userKey, value, now, lifetime);
        if (session && !found.has(session.nonce))
          found.set(session.nonce, { kind: "oidc", session });
      } else {
        const session =
          key === undefined ? undefined : verifySession(key, value, now);
        if (session && !found.has(session.nonce))
          found.set(session.nonce, { kind: "password", session });
      }
    }
    return [...found.values()];
  }

  /**
   * The valid, unrevoked session among the request's session cookies, if any, with who it is. A
   * cookie that fails its signature or expiry never reaches the store, so requests without a valid
   * cookie cost no query. Every validly signed cookie is checked against the shared store on every
   * request (no cache of "not revoked", so a logout on any instance is honoured by the next request
   * here); revocations already seen are remembered. A user session also reads the user's current
   * role (none: refused). A store failure answers `unavailable` (fail closed). Never rejects.
   */
  async sessionOf(req: IncomingMessage): Promise<SessionLookup> {
    let candidates: Candidate[];
    try {
      candidates = this.signedSessions(req).filter(
        (c) => !this.revokedSeen.has(c.session.nonce),
      );
    } catch {
      return NO_SESSION;
    }
    if (candidates.length === 0) return NO_SESSION;
    let revoked: ReadonlySet<string>;
    try {
      revoked = await this.revocations.revokedAmong(
        candidates.map((c) => c.session),
      );
    } catch {
      this.throttledWarn(
        "admin session check failed (database unavailable?): requests with a session answer 503",
      );
      return SESSION_UNAVAILABLE;
    }
    try {
      const now = this.nowSeconds();
      const live: Candidate[] = [];
      for (const candidate of candidates) {
        if (revoked.has(candidate.session.nonce))
          this.revokedSeen.revoke(candidate.session, now);
        else live.push(candidate);
      }
      for (const candidate of live) {
        if (candidate.kind === "password") {
          return {
            status: "valid",
            session: candidate.session,
            principal: PASSWORD_PRINCIPAL,
          };
        }
        let user: Awaited<ReturnType<UserStore["get"]>>;
        try {
          user = await this.users.get(candidate.session.userId);
        } catch {
          this.throttledWarn(
            "user session check failed (database unavailable?): requests with a session answer 503",
          );
          return SESSION_UNAVAILABLE;
        }
        if (user?.role === undefined) continue;
        // Issued before the user was last refused: those cookies stay dead after a re-add.
        if (
          candidate.session.issuedAtSeconds <=
          (user.sessionsValidAfterSeconds ?? -1)
        )
          continue;
        return {
          status: "valid",
          session: candidate.session,
          principal: Object.freeze({
            kind: "oidc",
            role: user.role,
            userId: user.id,
            label: user.email ?? user.name ?? user.subject,
          }),
        };
      }
      return NO_SESSION;
    } catch {
      return NO_SESSION;
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
    const method = (req.method ?? "").toUpperCase();
    // The OIDC callback is the identity provider's redirect back: a cross-site navigation by
    // nature. It is bound to this browser by the pending cookie's `state` (and PKCE), not by
    // `Sec-Fetch-Site`; only `GET`/`HEAD` reach it this way.
    const callback = OIDC_CALLBACK_ROUTE.test(path) && SAFE_METHODS.has(method);
    if (!callback && isCrossSite(req)) {
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
      LOGOUT_ROUTE.test(path) ||
      OIDC_START_ROUTE.test(path) ||
      OIDC_CALLBACK_ROUTE.test(path)
    ) {
      stamp(req, "login");
      return true;
    }
    if (!this.loginConfigured) {
      this.passwordNotSet(res, api);
      return false;
    }
    if (!SAFE_METHODS.has(method) && !originMatchesHost(req)) {
      // A state-changing method needs a same-origin `Origin`, session or not (CSRF; a same-site
      // page on another port receives the SameSite=Strict cookie).
      this.refuse(res, api, 403, "forbidden", "Origin not allowed.");
      return false;
    }
    return this.sessionOf(req).then((lookup) => {
      if (lookup.status === "valid") {
        if (lookup.principal.role !== "admin" && !SAFE_METHODS.has(method)) {
          // Issue #34: a viewer reads everything and changes nothing, on every route there is
          // and every route added later.
          this.refuse(res, api, 403, "forbidden", VIEWER_REFUSED);
          return false;
        }
        stamp(req, "session");
        stampPrincipal(req, lookup.principal);
        return true;
      }
      if (lookup.status === "unavailable") {
        writeRaw(res, {
          status: 503,
          csp: UI_CSP,
          contentType: api ? JSON_TYPE : TEXT_TYPE,
          headers: { "retry-after": "5" },
          body: api
            ? apiErrorBody(
                "unavailable",
                "The session could not be checked. Try again later.",
              )
            : "The session could not be checked. Try again later.",
        });
        return false;
      }
      this.unauthenticated(res, api, method);
      return false;
    });
  }

  /** No valid session: 401 for the API and writes, `303` to `/login` for a page. */
  private unauthenticated(
    res: ServerResponse,
    api: boolean,
    method: string,
  ): void {
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
   * the global budget. Valid tokens never reach here, so a lockout cannot refuse one. The
   * allowance and the budget are both shared by every instance (D-96). When the budget
   * cannot be read or charged: 503, nothing else said. Always resolves `false`; never rejects.
   */
  private async tokenMiss(
    req: IncomingMessage,
    res: ServerResponse,
    api: boolean,
  ): Promise<false> {
    let decision: LoginRateDecision;
    try {
      // The client's own allowance of misses (5 a minute, key `token:<client>`, apart from its
      // `/login` window) and a slot of the shared budget, in one atomic step; the slot is kept:
      // it is this failure. Shared by every instance (D-96).
      const rate = await this.limiter.take(`token:${this.clientOf(req)}`);
      decision = rate.ok ? { ok: true } : rate;
    } catch {
      this.throttledWarn(
        "login rate limit unavailable (database unavailable?)",
      );
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
    }
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
      return false;
    }
    this.refuseToken(res, api, TOKEN_REFUSED);
    return false;
  }

  /**
   * A request carrying `Authorization: Bearer nxt_…` (P8-01). Order: a sign-in configured
   * (503; tokens are managed by an admin, so they work only while an admin can sign in) →
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
    if (!this.loginConfigured) {
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
      return this.tokenMiss(req, res, api);
    }
    let lookup: Promise<VerifiedApiToken | undefined>;
    try {
      lookup = verifier.verify(bearer.value);
    } catch (error) {
      lookup = Promise.reject(error);
    }
    return lookup.then(
      (found) => {
        if (found === undefined) return this.tokenMiss(req, res, api);
        stamp(req, "token");
        stampPrincipal(req, TOKEN_PRINCIPAL);
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
    headers?: Record<string, string | readonly string[]>,
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
    headers?: Record<string, string | readonly string[]>,
  ): void {
    this.page(res, status, loginPage(notice, this.loginOptions), headers);
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

  /**
   * `GET /login`: the form (the password field and/or the single sign-on link), the 503 page, or
   * a redirect to `/` when already signed in (a session that cannot be checked counts as none: the
   * form is shown). Never rejects.
   */
  async showLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.loginConfigured) {
        this.page(res, 503, passwordNotSetPage());
        return;
      }
      if ((await this.sessionOf(req)).status === "valid") {
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
   * `POST /login`. Order: password configured (503; 403 with a notice when only OIDC signs in) →
   * `Origin` matches `Host` (403) → rate limit (429) → password, hashed on both sides and compared
   * with `timingSafeEqual` (401) → session cookie and `303 Location: /`. The redirect target is
   * fixed: no open redirect. The limiter keys on `clientOf` (trusted proxies, D-96); when it cannot
   * answer (budget slot or client window), 503 with the "unavailable" notice and no cookie (fail
   * closed). Both outcomes of the password check are written to the audit log. Never rejects.
   */
  async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const digest = this.passwordDigest;
      const key = this.key;
      if (digest === undefined || key === undefined) {
        if (this.loginConfigured) this.loginForm(res, 403, "password-disabled");
        else this.page(res, 503, passwordNotSetPage());
        return;
      }
      if (!originMatchesHost(req)) {
        this.loginForm(res, 403, "bad-origin");
        return;
      }
      // Admits the attempt and reserves its slot of the global failure budget in one atomic
      // step, before the password check: a concurrent burst gets at most the budget through.
      let rate: LoginTake;
      try {
        rate = await this.limiter.take(this.clientOf(req));
      } catch {
        this.loginUnavailable(res);
        return;
      }
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
        // The reserved slot stays: it is this failure.
        await this.audit.record({
          actor: { kind: "anonymous", label: BREAK_GLASS_ATTEMPT },
          action: "sign_in_failed",
          outcome: "failed",
          detail: "wrong_password",
          clientAddress: this.addressOf(req),
        });
        this.loginForm(res, 401, "wrong-password");
        return;
      }
      try {
        await this.limiter.release(rate.reservation);
      } catch {
        // The slot stays counted (the safe side); the password was right, so sign in.
        this.throttledWarn(
          "login rate limit: a budget slot could not be released",
        );
      }
      const expires = this.nowSeconds() + SESSION_TTL_SECONDS;
      const token = signSession(key, expires);
      await this.audit.record({
        actor: { kind: "password" },
        action: "sign_in",
        outcome: "ok",
        clientAddress: this.addressOf(req),
      });
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

  private loginUnavailable(
    res: ServerResponse,
    headers: Record<string, string | readonly string[]> = {},
  ): void {
    this.throttledWarn(
      "login rate limit unavailable (database unavailable?): sign-in answers 503",
    );
    this.loginForm(res, 503, "unavailable", { "retry-after": "5", ...headers });
  }

  // ---- OIDC (issue #34) ----------------------------------------------------------------------

  /**
   * `GET /login/oidc`: a new pending sign-in (32 random bytes each of `state`, `nonce` and the
   * PKCE verifier) in a signed `SameSite=Lax` cookie scoped to `/login/oidc` for 10 minutes, and a
   * `303` to the provider's authorization endpoint with the S256 challenge. 404 without OIDC; 503
   * (the "unavailable" notice) when the provider's metadata cannot be read. Never rejects.
   */
  async oidcStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const client = this.oidc;
      if (client === undefined) {
        writeRaw(res, {
          status: 404,
          csp: LOGIN_CSP,
          contentType: TEXT_TYPE,
          body: "Single sign-on is not configured.",
        });
        return;
      }
      const pending = {
        state: randomToken(),
        nonce: randomToken(),
        verifier: randomToken(),
      };
      let location: string;
      try {
        location = await client.authorizationUrl(pending);
      } catch {
        this.throttledWarn(
          "OIDC: the identity provider's metadata could not be read; single sign-on answers 503",
        );
        this.loginForm(res, 503, "sso-unavailable", { "retry-after": "10" });
        return;
      }
      const value = signPending(
        this.pendingKey,
        this.nowSeconds() + PENDING_TTL_SECONDS,
        pending,
      );
      writeRaw(res, {
        status: 303,
        csp: LOGIN_CSP,
        headers: {
          location,
          "set-cookie": this.pendingCookie(req, value, PENDING_TTL_SECONDS),
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
   * `GET /login/oidc/callback`. Order: OIDC configured (404) → a pending cookie whose `state` equals
   * the query's (constant time; 401 otherwise, at no cost to the login budget) → the login limiter,
   * as `POST /login` (429; 503 when it cannot answer) → no `error` from the provider and a `code` → the code exchange with the PKCE verifier
   * and the ID token's checks (oidc.ts) → the role claim mapped (admin, viewer, or refused: the
   * user's row then loses its role, ending its open sessions) → the user upserted → a `v2` session
   * cookie for `NESTRIX_OIDC_SESSION_SECONDS` and a small page that continues to `/` (a redirect
   * would keep the provider's cross-site context, and the browser would then withhold the
   * `SameSite=Strict` cookie from `/`). The pending cookie is cleared on every answer. Every
   * outcome is written to the audit log, failures with their reason code. Never rejects.
   */
  async oidcCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const clearPending = this.pendingCookie(req, "", 0);
    try {
      const client = this.oidc;
      const userKey = this.userKey;
      if (client === undefined || userKey === undefined) {
        writeRaw(res, {
          status: 404,
          csp: LOGIN_CSP,
          contentType: TEXT_TYPE,
          body: "Single sign-on is not configured.",
        });
        return;
      }
      const fail = async (
        reason: OidcFailure,
        actor: AuditActor = { kind: "anonymous" },
      ) => {
        await this.audit.record({
          actor,
          action: "sign_in_failed",
          outcome: "failed",
          detail: reason,
          clientAddress: this.addressOf(req),
        });
        this.throttledWarn(`OIDC sign-in failed: ${reason}`);
        const unavailable = reason === "store_unavailable";
        this.loginForm(
          res,
          unavailable ? 503 : reason === "not_allowed" ? 403 : 401,
          unavailable
            ? "unavailable"
            : reason === "not_allowed"
              ? "sso-not-allowed"
              : "sso-failed",
          { "set-cookie": clearPending },
        );
      };

      const query = new URLSearchParams(
        (
          (
            (req as { originalUrl?: string }).originalUrl ??
            req.url ??
            ""
          ).split("?")[1] ?? ""
        ).slice(0, 8192),
      );
      const state = query.getAll("state");
      const now = this.nowSeconds();
      const pending = getCookieValues(
        req.headers.cookie,
        pendingCookieName(req.socket?.localPort),
      )
        .slice(0, MAX_SESSION_COOKIES)
        .map((v) => verifyPending(this.pendingKey, v, now))
        .find(
          (p) =>
            p !== undefined &&
            state.length === 1 &&
            safeEqual(p.state, state[0] as string),
        );
      if (pending === undefined) {
        await fail(state.length === 1 ? "state_mismatch" : "state_missing");
        return;
      }
      // Only a request that carries the pending cookie and its matching state is charged to the
      // shared failed-login budget, so blind requests to the callback cannot lock out the password
      // form.
      let rate: LoginTake;
      try {
        rate = await this.limiter.take(this.clientOf(req));
      } catch {
        this.loginUnavailable(res, { "set-cookie": clearPending });
        return;
      }
      if (!rate.ok) {
        this.loginForm(res, 429, "rate-limited", {
          "retry-after": String(rate.retryAfterSeconds),
          "set-cookie": clearPending,
        });
        return;
      }
      if (query.has("error")) {
        await fail("idp_error");
        return;
      }
      const codes = query.getAll("code");
      if (
        codes.length !== 1 ||
        codes[0] === "" ||
        (codes[0] as string).length > 4096
      ) {
        await fail("code_missing");
        return;
      }
      let claims: Awaited<ReturnType<OidcClient["complete"]>>;
      try {
        claims = await client.complete(codes[0] as string, pending, now);
      } catch (error) {
        await fail(error instanceof OidcError ? error.reason : "internal");
        return;
      }
      const config = client.config;
      const record = {
        issuer: config.issuer,
        subject: claims.sub,
        email: claims.email,
        name: claims.name,
      };
      const label = claims.email ?? claims.name ?? claims.sub;
      const role: Role | undefined = roleFor(
        config,
        claimValues(claims.raw, config.roleClaim),
      );
      if (role === undefined) {
        let userId: number | undefined;
        try {
          userId = await this.users.refuse(record);
        } catch {
          await fail("store_unavailable", { kind: "anonymous", label });
          return;
        }
        await fail(
          "not_allowed",
          userId === undefined
            ? { kind: "anonymous", label }
            : { kind: "oidc", userId, label },
        );
        return;
      }
      let user: Awaited<ReturnType<UserStore["signIn"]>>;
      try {
        user = await this.users.signIn(record, role);
      } catch {
        await fail("store_unavailable", { kind: "anonymous", label });
        return;
      }
      try {
        await this.limiter.release(rate.reservation);
      } catch {
        this.throttledWarn(
          "login rate limit: a budget slot could not be released",
        );
      }
      await this.audit.record({
        actor: { kind: "oidc", userId: user.id, label },
        action: "sign_in",
        outcome: "ok",
        detail: role,
        clientAddress: this.addressOf(req),
      });
      const lifetime = config.sessionSeconds;
      const token = signUserSession(userKey, now + lifetime, user.id, now);
      this.page(res, 200, signedInPage(), {
        "set-cookie": [this.cookie(req, token, lifetime), clearPending],
      });
    } catch {
      writeRaw(res, {
        status: 500,
        csp: LOGIN_CSP,
        contentType: TEXT_TYPE,
        headers: { "set-cookie": clearPending },
        body: "Internal error.",
      });
    }
  }

  /**
   * `POST /logout`: `Origin` must match (403 otherwise, so another page cannot sign the admin
   * out); every validly signed session cookie of the request is revoked in the shared store until
   * it expires (already revoked ones again, harmlessly); the cookie is cleared; `303` to `/login`.
   * When the revocation cannot be stored: 503 and the cookie is **kept**, so the admin can retry
   * rather than believe a still-valid cookie is dead (D-96). A sign-out that ended a session is
   * written to the audit log. Never rejects.
   */
  async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      let sessions: Candidate[];
      try {
        sessions = this.signedSessions(req);
      } catch {
        sessions = [];
      }
      try {
        for (const candidate of sessions) {
          await this.revocations.revoke(candidate.session);
          this.revokedSeen.revoke(candidate.session, this.nowSeconds());
        }
      } catch {
        this.throttledWarn(
          "sign-out could not be recorded (database unavailable?): POST /logout answers 503",
        );
        writeRaw(res, {
          status: 503,
          csp: LOGIN_CSP,
          contentType: TEXT_TYPE,
          headers: { "retry-after": "5" },
          body: "Signing out could not be recorded: the server cannot reach its database. Try again shortly.",
        });
        return;
      }
      const first = sessions[0];
      if (first !== undefined) {
        let actor: AuditActor = { kind: "password" };
        if (first.kind === "oidc") {
          let label = `user ${first.session.userId}`;
          try {
            const user = await this.users.get(first.session.userId);
            if (user) label = user.email ?? user.name ?? user.subject;
          } catch {
            // The label falls back to the id.
          }
          actor = { kind: "oidc", userId: first.session.userId, label };
        }
        await this.audit.record({
          actor,
          action: "sign_out",
          outcome: "ok",
          clientAddress: this.addressOf(req),
        });
      }
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

  /**
   * The pending OIDC sign-in: `SameSite=Lax` (the provider's redirect back is a cross-site
   * top-level navigation, which a `Strict` cookie would not join), `Path=/login/oidc`.
   */
  private pendingCookie(
    req: IncomingMessage,
    value: string,
    maxAge: number,
  ): string {
    const secure = !isLoopbackPlainHttp(req);
    return `${pendingCookieName(req.socket?.localPort)}=${value}; Path=${OIDC_START_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  }
}

/** The audit label of a failed break-glass password attempt. */
const BREAK_GLASS_ATTEMPT = "break-glass password";
const VIEWER_REFUSED =
  "Your role is viewer: you can read everything but change nothing. Ask an admin.";
