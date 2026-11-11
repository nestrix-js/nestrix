/**
 * HTTP server spans (architecture §4.2 "HTTP server span", nest-hooks.md §1 and §2).
 *
 * - `setOnRequestHook`: extract W3C context, start the server span, attach a `close` listener to
 *   the raw response, and call `done()` exactly once inside the span's context.
 * - `setOnRouteTriggered`: chained with any previous callback; records the route template in
 *   Nestrix's own request state, found through Nestrix's own context key.
 * - The span ends on the raw response's `close`, with the outcome rule below.
 * - With the `user` option (P3-03): the user's function is called once per recording span at
 *   `close`, before `span.end()`, with the request object the adapter passed to the hook, and its
 *   result is recorded as `user.id`. Guarded and counted like every other step.
 * - When the dashboard is on (a `DashboardHookConfig` is passed; P2-04): route statistics are
 *   recorded at the same `close`, for every request that has a state, recording or not (D-35);
 *   a request under the dashboard path gets no span and no statistics, only a minimal state
 *   whose `close` check reports shadowing. With no config, nothing of this runs.
 *
 * Imports `@opentelemetry/api` only (AGENTS.md rule 5). Every hook body catches everything
 * (rule 1); a failure is counted and logged once (`diagnostics.countFailure`).
 */
import {
  type Attributes,
  context,
  defaultTextMapGetter,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_REQUEST_METHOD_ORIGINAL,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_NETWORK_PROTOCOL_VERSION,
  ATTR_URL_PATH,
  ATTR_URL_QUERY,
  ATTR_URL_SCHEME,
  ATTR_USER_AGENT_ORIGINAL,
} from "@opentelemetry/semantic-conventions";
import type { Diagnostics } from "../diagnostics.js";
import type { HttpRequestMetrics } from "../metrics/http.js";
import type { UrlMatcher } from "../options.js";
import { describeForeignRouteHook } from "../otel/detect.js";
import {
  buildHeaderAllowlist,
  buildRedactedQueryKeys,
  collectHeaderAttributes,
  DEFAULT_REQUEST_HEADERS,
  DEFAULT_RESPONSE_HEADERS,
  type HeadersInput,
  headerAttributes,
  REQUEST_HEADER_PREFIX,
  RESPONSE_HEADER_PREFIX,
  redactQuery,
  splitUrl,
} from "../privacy.js";
import type {
  NestrixUserFunction,
  ResolvedOptions,
} from "../resolve-options.js";
import { type RouteStatistics, UNMATCHED_ROUTE } from "../stats/route-stats.js";
import {
  type DashboardRequestState,
  getStateFromContext,
  maybeFault,
  REQUEST_STATE_KEY,
  type RequestState,
  setDashboardStateForRequest,
  setStateForRequest,
} from "./request-state.js";

/**
 * What the request hook needs when the dashboard is on (P2-04; P2-06 builds it from the
 * resolved `ui` mode). Absent, the hook behaves exactly as in phase 1.
 */
export interface DashboardHookConfig {
  /**
   * The resolved dashboard path: starts with `/`, no trailing slash (P2-05 validates). A request
   * whose raw path (before `?`) equals it or starts with it plus `/` is a dashboard request. A
   * value that is not at least two characters starting with `/` matches nothing.
   */
  readonly dashboardPath: string;
  /**
   * Called at most once per dashboard request, at the raw response's `close`, when a response
   * was sent (`headersSent`) and no Nestrix dashboard handler marked the request
   * (`markDashboardHandlerReached`), the method is `GET` or `HEAD` and the status is not 404 (Nest's
   * own 404 for an unregistered sub-path, and CORS or automatic `OPTIONS` replies, are not
   * shadowing). Receives the status code sent. A throw, or a rejection of a returned promise, is
   * caught and counted.
   */
  readonly onShadowed: (status: number) => unknown;
  /** Where route statistics are recorded; P2-06 queries the same instance. */
  readonly stats: RouteStatistics;
}

/**
 * Whether a raw request target is the dashboard path or under it: equal to `path`, or starting
 * with `path` followed by `/`, `?` or `#`. The prefix is compared ASCII case-insensitively, on the
 * raw target. Allocation-free in the common (origin-form) case.
 */
export function isDashboardTarget(target: string, path: string): boolean {
  if (path.length < 2 || path.charCodeAt(0) !== 47) return false; // "/"
  // Absolute-form target (`GET http://host/path`, RFC 9112 §3.2.2): drop `scheme://authority`.
  // The normal origin-form case starts with "/" and allocates nothing. Case variants of the path
  // (`/_NESTRIX`) match too: routers that ignore case (Express `caseSensitive: false`, Fastify
  // `caseSensitive: false`) would serve the dashboard under them, and such a request must not
  // become a span or a route statistic.
  if (target.charCodeAt(0) !== 47) target = stripAuthority(target);
  if (target.length < path.length) return false;
  for (let i = 0; i < path.length; i++) {
    let a = target.charCodeAt(i);
    let b = path.charCodeAt(i);
    if (a >= 65 && a <= 90) a += 32;
    if (b >= 65 && b <= 90) b += 32;
    if (a !== b) return false;
  }
  if (target.length === path.length) return true;
  const next = target.charCodeAt(path.length);
  return next === 47 || next === 63 || next === 35; // "/", "?", "#"
}

/** `scheme://authority/rest` to `/rest` (or `/` when nothing follows); anything else unchanged. */
function stripAuthority(target: string): string {
  const sep = target.indexOf("://");
  if (sep <= 0) return target;
  const rest = target.slice(sep + 3);
  const slash = rest.search(/[/?#]/);
  if (slash < 0) return "/";
  return rest.charCodeAt(slash) === 47
    ? rest.slice(slash)
    : `/${rest.slice(slash)}`;
}

/** Tracer name for Nestrix's own spans. Tracers are obtained at use time (§4.5). */
export const TRACER_NAME = "@nestrix-js/nestjs";

/** `nestrix.http.aborted` (backlog "Public API"). */
export const ATTR_NESTRIX_HTTP_ABORTED = "nestrix.http.aborted";

/** `user.id` (OpenTelemetry semantic conventions, `user` namespace). Set from the `user` option. */
export const ATTR_USER_ID = "user.id";

/** Longest `user.id` recorded; a longer value is cut to this many characters (P3-03). */
export const MAX_USER_ID_LENGTH = 256;

/**
 * The `user` function's result as a `user.id` value: a non-empty string, or a finite number or
 * a bigint as its decimal text, cut to {@link MAX_USER_ID_LENGTH} characters (never inside a
 * surrogate pair). `undefined` and `null` (and `''`) mean no user. Anything else is invalid
 * (`false` returned) and the caller counts it.
 */
export function userIdOf(value: unknown): string | undefined | false {
  let text: string;
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" && Number.isFinite(value)) {
    text = String(value);
  } else if (typeof value === "bigint") text = value.toString();
  else return false;
  if (text === "") return undefined;
  if (text.length <= MAX_USER_ID_LENGTH) return text;
  const last = text.charCodeAt(MAX_USER_ID_LENGTH - 1);
  // A high surrogate as the last kept unit would leave half a character.
  return text.slice(
    0,
    last >= 0xd800 && last <= 0xdbff
      ? MAX_USER_ID_LENGTH - 1
      : MAX_USER_ID_LENGTH,
  );
}

/** The kind of a value, for a log line that must not contain the value itself (it may be personal data). */
function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return "a non-finite number";
  if (
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  ) {
    return "a promise (it must be synchronous)";
  }
  return `a value of type ${typeof value}`;
}

/** Methods the HTTP semantic conventions name; anything else is `_OTHER`. */
const KNOWN_METHODS = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
]);

type Done = (err?: Error) => void;
type RequestHook = (req: unknown, res: unknown, done: Done) => void;
type RouteHook = (requestMethod: unknown, path: string) => void;

/** The parts of a raw `IncomingMessage` the hook reads. */
interface RawRequest {
  method?: unknown;
  url?: unknown;
  headers?: HeadersInput;
  httpVersion?: unknown;
  socket?: { encrypted?: unknown; destroyed?: unknown } | null;
}

/** The parts of a raw `ServerResponse` the hook reads. */
interface RawResponse {
  once(event: "close", listener: () => void): unknown;
  headersSent?: unknown;
  statusCode?: unknown;
  writableEnded?: unknown;
  writableFinished?: unknown;
  closed?: unknown;
  getHeaders?: () => HeadersInput;
}

/** The parts of an adapter Nestrix calls. All three built-in adapters have them (nest-hooks §2). */
export interface HookableAdapter {
  setOnRequestHook(hook: RequestHook): void;
  setOnRouteTriggered?(hook: RouteHook): void;
  getOnRouteTriggered?(): unknown;
}

/** The parts of `HttpAdapterHost` Nestrix reads. */
export interface AdapterHostLike {
  readonly httpAdapter?: unknown;
  readonly init$?: unknown;
}

/** Fastify passes wrappers carrying the Node objects as `raw`; Express and platform-node pass them directly. */
function unwrap(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const raw = (value as { raw?: unknown }).raw;
  return raw !== null &&
    typeof raw === "object" &&
    typeof (raw as { on?: unknown }).on === "function"
    ? raw
    : value;
}

function matches(matcher: UrlMatcher, path: string): boolean {
  if (typeof matcher === "string") return matcher === path;
  if (matcher instanceof RegExp) return path.search(matcher) !== -1; // ignores `lastIndex` and `g`
  if (typeof matcher === "function") return matcher(path) === true;
  return false;
}

/**
 * The server's `url.path` and redacted `url.query`. An origin-form target (`/…`, including one
 * starting with `//`) is split here, so its first segment is kept: `splitUrl` reads a leading
 * `//` as an authority (P1-04), which is right for a URL and wrong for a request target. Any
 * other form (absolute-form `http://host/…`, `*`) goes through `splitUrl`, which drops the
 * scheme, authority and any userinfo.
 */
export function splitTarget(
  target: string,
  keys: ReadonlySet<string>,
): { path: string; query?: string } {
  if (!target.startsWith("/")) return splitUrl(target, keys);
  const hash = target.indexOf("#");
  const t = hash === -1 ? target : target.slice(0, hash);
  const q = t.indexOf("?");
  if (q === -1) return { path: t };
  const query = redactQuery(t.slice(q + 1), keys);
  return query === ""
    ? { path: t.slice(0, q) }
    : { path: t.slice(0, q), query };
}

/**
 * Whether the response was cut short. Read at the raw response's `close` (P0-S1, P1-06):
 * - `!writableEnded`: the app had not finished the response (client went away, or the socket
 *   was destroyed). Detected on every Node version.
 * - `writableEnded && !writableFinished`: the app finished, delivery was cut. Visible from
 *   Node 24.20 only.
 * - The request's socket already destroyed at `close`: the same cut on Node 22.x and 24 before
 *   24.20, where `writableFinished` is already true (research.md "Delivery cut"). Measured
 *   false at `close` for completed keep-alive, `Connection: close`, HTTP/1.0, pipelined and
 *   unread-body responses on 22.15, 24.16 and 26.13.
 */
export function wasAborted(rawReq: RawRequest, rawRes: RawResponse): boolean {
  if (rawRes.writableEnded !== true) return true;
  if (rawRes.writableFinished !== true) return true;
  return rawReq.socket?.destroyed === true;
}

export class HttpServerInstrumentation {
  private readonly ignore: readonly UrlMatcher[];
  private readonly requestHeaders: ReadonlySet<string>;
  private readonly responseHeaders: ReadonlySet<string>;
  private readonly queryKeys: ReadonlySet<string>;
  private readonly user: NestrixUserFunction | undefined;

  constructor(
    options: ResolvedOptions,
    private readonly diagnostics: Diagnostics,
    private readonly dashboard?: DashboardHookConfig,
    /** P6-02: records `http.server.request.duration` at `close`. Absent with `metrics: false`. */
    private readonly metrics?: HttpRequestMetrics,
  ) {
    this.ignore = options.ignore.paths;
    this.requestHeaders = buildHeaderAllowlist(
      DEFAULT_REQUEST_HEADERS,
      options.http.requestHeaders,
    );
    this.responseHeaders = buildHeaderAllowlist(
      DEFAULT_RESPONSE_HEADERS,
      options.http.responseHeaders,
    );
    this.queryKeys = buildRedactedQueryKeys(options.http.redactQueryKeys);
    this.user = options.user;
  }

  /**
   * The request hook. Synchronous, never throws, returns nothing, and calls `done()` exactly
   * once on every path (nest-hooks §2). An error thrown by `done()` itself is Nest's own
   * continuation and is rethrown unchanged, as it would be without Nestrix.
   */
  readonly requestHook: RequestHook = (req, res, done) => {
    let ctx: ReturnType<typeof context.active> | undefined;
    try {
      maybeFault("request-hook");
      ctx = this.start(req, res);
    } catch (error) {
      this.diagnostics.countFailure("http.request-hook", error);
      ctx = undefined;
    }
    if (ctx === undefined) {
      done();
      return;
    }
    let called = false;
    let doneThrew = false;
    let doneError: unknown;
    try {
      context.with(ctx, () => {
        called = true;
        try {
          done();
        } catch (error) {
          doneThrew = true;
          doneError = error;
        }
      });
    } catch (error) {
      // Thrown by the context manager, not by Nest.
      this.diagnostics.countFailure("http.request-hook", error);
      if (!called) done();
    }
    if (doneThrew) throw doneError;
  };

  /** A route-triggered hook that records the route, then calls `previous` exactly once, outside its guard. */
  routeHook(previous: unknown): RouteHook {
    const prev =
      typeof previous === "function" ? (previous as RouteHook) : undefined;
    const diagnostics = this.diagnostics;
    return function nestrixRouteTriggered(requestMethod, path) {
      try {
        maybeFault("route-hook");
        const state = getStateFromContext(context.active());
        if (state && typeof path === "string") state.route = path;
      } catch (error) {
        diagnostics.countFailure("http.route-hook", error);
      }
      if (prev) prev(requestMethod, path);
    };
  }

  /** Starts the span and returns the context to run the request in, or `undefined` for no span. */
  private start(
    req: unknown,
    res: unknown,
  ): ReturnType<typeof context.active> | undefined {
    const rawReq = unwrap(req) as RawRequest | null | undefined;
    const rawRes = unwrap(res) as RawResponse | null | undefined;
    if (!rawReq || typeof rawReq !== "object") return undefined;
    if (!rawRes || typeof rawRes.once !== "function") return undefined;

    const target = typeof rawReq.url === "string" ? rawReq.url : "";
    const dashboard = this.dashboard;
    if (
      dashboard !== undefined &&
      isDashboardTarget(target, dashboard.dashboardPath)
    ) {
      this.startDashboardRequest(rawReq, rawRes, dashboard);
      return undefined; // no span: `done()` runs in the context Nest gave the hook
    }
    const { path, query } = splitTarget(target, this.queryKeys);
    if (this.isIgnored(path)) return undefined;

    const received =
      typeof rawReq.method === "string" ? rawReq.method.toUpperCase() : "";
    const known = KNOWN_METHODS.has(received);
    const baseName = known ? received : "HTTP";

    const scheme = rawReq.socket?.encrypted ? "https" : "http";
    const attributes: Attributes = {
      [ATTR_HTTP_REQUEST_METHOD]: known ? received : "_OTHER",
      [ATTR_URL_PATH]: path,
      [ATTR_URL_SCHEME]: scheme,
    };
    if (!known) attributes[ATTR_HTTP_REQUEST_METHOD_ORIGINAL] = received;
    if (query !== undefined) attributes[ATTR_URL_QUERY] = query;
    if (typeof rawReq.httpVersion === "string") {
      attributes[ATTR_NETWORK_PROTOCOL_VERSION] = rawReq.httpVersion;
    }
    const headers = rawReq.headers;
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
      const ua = (headers as Record<string, unknown>)["user-agent"];
      if (typeof ua === "string") attributes[ATTR_USER_AGENT_ORIGINAL] = ua;
    }
    // Straight into `attributes`: the prefixed keys never exist there yet, so this equals
    // assigning `headerAttributes(...)` without the intermediate object (P2-15).
    collectHeaderAttributes(
      headers,
      this.requestHeaders,
      REQUEST_HEADER_PREFIX,
      attributes,
    );

    const parent = propagation.extract(
      context.active(),
      headers ?? {},
      defaultTextMapGetter,
    );
    const span = trace
      .getTracer(TRACER_NAME)
      .startSpan(baseName, { kind: SpanKind.SERVER, attributes }, parent);
    const state: RequestState = {
      span,
      method: received,
      baseName,
      route: undefined,
      reached: false,
      exception: undefined,
      ended: false,
      scheme,
      startedAt:
        dashboard !== undefined || this.metrics !== undefined
          ? performance.now()
          : 0,
    };
    setStateForRequest(rawReq, state);
    // The listener holds the state itself: on a client abort it runs outside the request's
    // async context (P0-S1), so it must not look anything up from the active context.
    const responseHeadersSource =
      res !== null &&
      typeof res === "object" &&
      typeof (res as RawResponse).getHeaders === "function"
        ? (res as RawResponse)
        : rawRes;
    // The `user` function gets the request object the adapter passed to the hook (Fastify's
    // `FastifyRequest`, not its `raw`): that is the object guards see and set `user` on.
    rawRes.once("close", () =>
      this.finish(state, rawReq, rawRes, responseHeadersSource, req),
    );
    if (rawRes.closed === true) {
      // Already closed before the hook ran: `close` will not come again.
      this.finish(state, rawReq, rawRes, responseHeadersSource, req);
    }
    return trace.setSpan(parent, span).setValue(REQUEST_STATE_KEY, state);
  }

  /**
   * A request under the dashboard path: a minimal state P2-06's handlers mark, and a `close`
   * check that reports a response no dashboard handler wrote.
   */
  private startDashboardRequest(
    rawReq: RawRequest,
    rawRes: RawResponse,
    dashboard: DashboardHookConfig,
  ): void {
    const state: DashboardRequestState = {
      handlerReached: false,
      closed: false,
    };
    setDashboardStateForRequest(rawReq, state);
    rawRes.once("close", () =>
      this.finishDashboard(state, rawReq, rawRes, dashboard),
    );
    if (rawRes.closed === true)
      this.finishDashboard(state, rawReq, rawRes, dashboard);
  }

  /** The shadowing check at `close`. Never throws. */
  private finishDashboard(
    state: DashboardRequestState,
    rawReq: RawRequest,
    rawRes: RawResponse,
    dashboard: DashboardHookConfig,
  ): void {
    try {
      maybeFault("dashboard-close");
      if (state.closed) return;
      state.closed = true;
      if (state.handlerReached) return;
      // Nothing sent (the client went away first) says nothing about shadowing.
      if (rawRes.headersSent !== true || typeof rawRes.statusCode !== "number")
        return;
      // Nest's own 404 (an unregistered sub-path) and CORS or automatic `OPTIONS` replies are
      // not shadowing: only a `GET` or `HEAD` answered by something else, with a non-404 status.
      const method = (rawReq.method as unknown) ?? "";
      if (method !== "GET" && method !== "HEAD") return;
      if (rawRes.statusCode === 404) return;
      const result = dashboard.onShadowed(rawRes.statusCode);
      if (
        result !== null &&
        typeof result === "object" &&
        typeof (result as { then?: unknown }).then === "function"
      ) {
        (result as PromiseLike<unknown>).then(undefined, (e: unknown) =>
          this.diagnostics.countFailure("http.dashboard-close", e),
        );
      }
    } catch (error) {
      this.diagnostics.countFailure("http.dashboard-close", error);
    }
  }

  /**
   * Counts the request in the route statistics. Two clock reads: `performance.now()` for the
   * duration, `Date.now()` for the minute bucket. Its own guard, so a failure
   * here leaves the span untouched, and a span failure cannot skip the count.
   */
  private recordStats(
    stats: RouteStatistics,
    state: RequestState,
    status: number | undefined,
    route: string | undefined,
  ): void {
    try {
      maybeFault("stats-record");
      const now = performance.now();
      const wall = Date.now(); // wall clock for the minute bucket: right after a laptop sleeps
      const exception = state.exception;
      // Error definition (backlog "Public API"): a 5xx sent, or a handler exception that maps
      // to 5xx (whatever a filter then sent). A 4xx, thrown or not, is not an error.
      const error =
        (status !== undefined && status >= 500) ||
        (exception !== undefined && exception.status >= 500);
      stats.record(
        state.baseName === "HTTP" ? "_OTHER" : state.method,
        route ?? UNMATCHED_ROUTE,
        now - (state.startedAt ?? now),
        error,
        wall,
      );
    } catch (error) {
      this.diagnostics.countFailure("stats.record", error);
    }
  }

  /**
   * The `user` option (P3-03): called only for a recording span, once (the caller runs once per
   * span), before the span ends. A throw, an invalid result or a returned promise records nothing
   * and is counted; a returned promise's rejection is handled so it never reaches
   * `unhandledRejection`. Its own guard, so a failure here leaves the rest of `finish` untouched.
   */
  private recordUser(span: Span, request: unknown): void {
    const user = this.user;
    if (user === undefined) return;
    try {
      maybeFault("user");
      if (!span.isRecording()) return;
      const value: unknown = user(request);
      const id = userIdOf(value);
      if (id === false) {
        if (
          value !== null &&
          typeof value === "object" &&
          typeof (value as { then?: unknown }).then === "function"
        ) {
          try {
            (value as PromiseLike<unknown>).then(undefined, () => undefined);
          } catch {
            // A thenable whose `then` throws: nothing pending to handle.
          }
        }
        this.diagnostics.countFailure(
          "http.user",
          new TypeError(
            `the user option returned ${kindOf(value)}; expected a string, a number or undefined`,
          ),
        );
        return;
      }
      if (id !== undefined) span.setAttribute(ATTR_USER_ID, id);
    } catch (error) {
      this.diagnostics.countFailure("http.user", error);
    }
  }

  private isIgnored(path: string): boolean {
    for (const matcher of this.ignore) {
      try {
        if (matches(matcher, path)) return true;
      } catch (error) {
        // A user matcher that throws counts as a match (options.ts): the request is ignored,
        // and the failure is counted. Either way the host's request is unaffected.
        this.diagnostics.countFailure("http.ignore-routes", error);
        return true;
      }
    }
    return false;
  }

  /** Ends the span at `close`. Never throws. */
  private finish(
    state: RequestState,
    rawReq: RawRequest,
    rawRes: RawResponse,
    headersSource: RawResponse,
    request?: unknown,
  ): void {
    try {
      maybeFault("close-listener");
      if (state.ended) return;
      state.ended = true;
      const span = state.span;
      const headersSent = rawRes.headersSent === true;
      const status =
        headersSent && typeof rawRes.statusCode === "number"
          ? rawRes.statusCode
          : undefined;

      // 404 rule (architecture §4.2): a request that ended in 404 without reaching Nestrix's
      // interceptor matched no handler, even if the route hook fired for a handler whose version
      // or host filter then declined.
      const route =
        state.route !== undefined && !(status === 404 && !state.reached)
          ? state.route
          : undefined;

      const stats = this.dashboard?.stats;
      if (stats !== undefined) this.recordStats(stats, state, status, route);
      // P6-02: its own guard inside `record` (never throws), sampled or not, like the statistics.
      this.metrics?.record(state, status, route);

      if (status !== undefined) {
        span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, status);
        try {
          const headers = headersSource.getHeaders?.();
          const attrs = headerAttributes(
            headers,
            this.responseHeaders,
            RESPONSE_HEADER_PREFIX,
          );
          for (const key of Object.keys(attrs)) {
            span.setAttribute(key, attrs[key] as string[]);
          }
        } catch (error) {
          this.diagnostics.countFailure("http.response-headers", error);
        }
      }

      if (route !== undefined) {
        span.setAttribute(ATTR_HTTP_ROUTE, route);
        span.updateName(`${state.baseName} ${route}`);
      }

      if (wasAborted(rawReq, rawRes)) {
        span.setAttribute(ATTR_NESTRIX_HTTP_ABORTED, true);
      }

      // Error status from the final outcome plus what the interceptor saw (P1-07): a 5xx that
      // was sent; or, when nothing was sent, an exception that maps to 5xx. An error a filter
      // turned into a 2xx or 4xx leaves the status unset (its event is still on the span).
      const exception = state.exception;
      const isError =
        status !== undefined
          ? status >= 500
          : exception !== undefined && exception.status >= 500;
      if (isError) {
        span.setAttribute(
          ATTR_ERROR_TYPE,
          exception !== undefined && exception.status >= 500
            ? exception.type
            : String(status),
        );
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      if (this.user !== undefined) this.recordUser(span, request);
      span.end();
    } catch (error) {
      this.diagnostics.countFailure("http.close-listener", error);
      try {
        // Never leave the span open because an attribute failed.
        state.ended = true;
        state.span.end();
      } catch {
        // Counted above.
      }
    }
  }
}

function isHookable(adapter: unknown): adapter is HookableAdapter {
  return (
    adapter !== null &&
    typeof adapter === "object" &&
    typeof (adapter as HookableAdapter).setOnRequestHook === "function"
  );
}

/**
 * Installs the hooks on the HTTP adapter, now or when `HttpAdapterHost.init$` emits one
 * (`@nestjs/testing`, nest-hooks §1). Installs nothing when there is no adapter
 * (`createMicroservice`, `createApplicationContext`: `httpAdapter` is `null`, `init$` emits
 * `null` or never). Returns a disposer that drops a pending `init$` subscription. Never throws.
 */
export function installHttpInstrumentation(
  adapterHost: AdapterHostLike | null | undefined,
  options: ResolvedOptions,
  diagnostics: Diagnostics,
  dashboard?: DashboardHookConfig,
  metrics?: HttpRequestMetrics,
): () => void {
  const noop = () => undefined;
  try {
    if (!adapterHost) return noop;
    const instrumentation = new HttpServerInstrumentation(
      options,
      diagnostics,
      dashboard,
      metrics,
    );
    let installed = false;
    const install = (adapter: unknown): void => {
      if (installed || !isHookable(adapter)) return;
      installed = true;
      const foreign = describeForeignRouteHook(adapter);
      if (foreign !== undefined)
        diagnostics.logOnce("http.foreign-route-hook", foreign);
      adapter.setOnRequestHook(instrumentation.requestHook);
      if (typeof adapter.setOnRouteTriggered === "function") {
        const previous =
          typeof adapter.getOnRouteTriggered === "function"
            ? adapter.getOnRouteTriggered()
            : undefined;
        adapter.setOnRouteTriggered(instrumentation.routeHook(previous));
      }
    };

    const adapter = adapterHost.httpAdapter;
    if (adapter) {
      install(adapter);
      return noop;
    }

    const init$ = adapterHost.init$ as
      | {
          subscribe?: (observer: {
            next: (value: unknown) => void;
            error: () => void;
          }) => { unsubscribe(): void };
        }
      | null
      | undefined;
    if (!init$ || typeof init$.subscribe !== "function") return noop;
    // The subscriber runs inside Nest's adapter setter; a throw there would surface as an
    // asynchronous `uncaughtException` (P0-S1 Q7), so its whole body is guarded. `init$` emits
    // no value (the setter calls `_init$.next()` and then completes it), so the adapter is read
    // from the host; it is `null` under createMicroservice / createApplicationContext.
    const subscription = init$.subscribe({
      next: () => {
        try {
          const current = adapterHost.httpAdapter;
          if (current) install(current);
          maybeFault("init-subscriber");
        } catch (error) {
          diagnostics.countFailure("http.init-subscriber", error);
        }
      },
      error: noop,
    });
    return () => {
      try {
        subscription.unsubscribe();
      } catch (error) {
        diagnostics.countFailure("http.init-unsubscribe", error);
      }
    };
  } catch (error) {
    diagnostics.countFailure("http.install", error);
    return noop;
  }
}
