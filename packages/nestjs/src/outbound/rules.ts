/**
 * The rules every outbound subscriber shares (architecture §4.2 "Rules for every hook and
 * subscriber"): the suppress-tracing key, no client span without an active parent, the host
 * ignore list, attributes and URL privacy, header injection that never overrides the caller,
 * and how a client span ends. Used by `node-http.ts` (P1-08) and `undici.ts` (P1-09).
 *
 * Imports `@opentelemetry/api` only (AGENTS.md rule 5). Tracers are obtained at use time.
 * Nothing here may throw into a diagnostics-channel publisher: callers wrap every body, and the
 * helpers below are written not to throw on odd input either.
 */
import {
  type Attributes,
  type Context,
  createContextKey,
  isSpanContextValid,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TimeInput,
  trace,
} from "@opentelemetry/api";
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_REQUEST_METHOD_ORIGINAL,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL,
  ERROR_TYPE_VALUE_OTHER,
  HTTP_REQUEST_METHOD_VALUE_OTHER,
} from "@opentelemetry/semantic-conventions";
import type { Diagnostics } from "../diagnostics.js";
import type { UrlMatcher } from "../options.js";
import {
  buildHeaderAllowlist,
  buildRedactedQueryKeys,
  DEFAULT_REQUEST_HEADERS,
  DEFAULT_RESPONSE_HEADERS,
  type HeadersInput,
  headerAttributes,
  REQUEST_HEADER_PREFIX,
  RESPONSE_HEADER_PREFIX,
  redactQuery,
  splitUrl,
} from "../privacy.js";
import type { ResolvedOptions } from "../resolve-options.js";

export const TRACER_NAME = "@nestrix-js/nestjs";

/**
 * OpenTelemetry's suppress-tracing key. The SDK's span processors wrap every export in a context
 * with this key set to `true` (`suppressTracing` in `@opentelemetry/core`), so honouring it keeps
 * every SDK exporter's own requests out of the traces. Context keys compare by description
 * (`Symbol.for`), so this one is reachable through the API alone.
 */
export const SUPPRESS_TRACING_KEY = createContextKey(
  "OpenTelemetry SDK Context Key SUPPRESS_TRACING",
);

/**
 * `nestrix.http.body`: `"not consumed"` when the client span ended at the response head because
 * nothing read the body; `"cancelled"` when the caller cancelled or aborted the body after the
 * head arrived (not an error: the status recorded from the head stands).
 */
export const ATTR_NESTRIX_HTTP_BODY = "nestrix.http.body";
export const BODY_NOT_CONSUMED = "not consumed";
export const BODY_CANCELLED = "cancelled";

/** Everything the subscribers need from the options, computed once at install. */
export interface OutboundConfig {
  readonly requestHeaders: ReadonlySet<string>;
  readonly responseHeaders: ReadonlySet<string>;
  readonly queryKeys: ReadonlySet<string>;
  readonly ignore: readonly UrlMatcher[];
  readonly diagnostics: Diagnostics;
}

export function buildOutboundConfig(
  options: ResolvedOptions,
  diagnostics: Diagnostics,
): OutboundConfig {
  return {
    requestHeaders: buildHeaderAllowlist(
      DEFAULT_REQUEST_HEADERS,
      options.http.requestHeaders,
    ),
    responseHeaders: buildHeaderAllowlist(
      DEFAULT_RESPONSE_HEADERS,
      options.http.responseHeaders,
    ),
    queryKeys: buildRedactedQueryKeys(options.http.redactQueryKeys),
    ignore: options.ignore.outgoing,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------------------------
// Fault injection (tests only; not exported from the package entry point)
// ---------------------------------------------------------------------------------------------

let faultInjector: ((site: string) => void) | undefined;

/** Internal, for tests: `fn` runs at the start of every guarded subscriber body and may throw. */
export function setOutboundFaultForTests(
  fn: ((site: string) => void) | undefined,
): void {
  faultInjector = fn;
}

/** Called first inside each guarded body. */
export function fault(site: string): void {
  if (faultInjector !== undefined) faultInjector(site);
}

// ---------------------------------------------------------------------------------------------
// The three "is this traced at all" rules
// ---------------------------------------------------------------------------------------------

/**
 * The parent context for a client span, or `undefined` when no span may be created:
 * 1. the context carries the suppress-tracing key (an SDK exporter's own request);
 * 2. there is no active span with a valid span context (background work, another tool's
 *    transport outside a request).
 * An active but unsampled parent still yields a context: the client span is then non-recording,
 * and the propagated `traceparent` carries the sampling decision downstream.
 */
export function parentContext(ctx: Context): Context | undefined {
  if (ctx.getValue(SUPPRESS_TRACING_KEY) === true) return undefined;
  const parent = trace.getSpan(ctx);
  if (parent === undefined) return undefined;
  if (!isSpanContextValid(parent.spanContext())) return undefined;
  return ctx;
}

/**
 * Rule 3, the host ignore list, matched against the URL as recorded in `url.full` (no userinfo,
 * no fragment, listed query values already `REDACTED`). A string matches when the URL starts
 * with it (`"https://o1.ingest.sentry.io/"` covers every request under it); a RegExp is tested
 * against the URL; a function receives it. A matcher that throws counts as a match: tracing is
 * skipped for that request, which leaves the request itself untouched.
 */
export function isIgnored(url: string, config: OutboundConfig): boolean {
  const matchers = config.ignore;
  for (let i = 0; i < matchers.length; i++) {
    const m = matchers[i];
    try {
      if (typeof m === "string") {
        if (m !== "" && url.startsWith(m)) return true;
      } else if (typeof m === "function") {
        if (m(url) === true) return true;
      } else if (m !== null && typeof m === "object" && "test" in m) {
        m.lastIndex = 0;
        if (m.test(url)) return true;
      }
    } catch (error) {
      config.diagnostics.countFailure("outbound.ignore-matcher", error);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------------------------

const KNOWN_METHODS: ReadonlySet<string> = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "QUERY",
  "TRACE",
]);

/** Where the request goes, already privacy-safe. */
export interface ClientTarget {
  /** `url.full`: scheme, host, port when not the default, path, redacted query. */
  readonly full: string;
  readonly address: string;
  /** `undefined` when the port cannot be known (see `node-http.ts`). */
  readonly port: number | undefined;
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  "http:": 80,
  "https:": 443,
};

export function defaultPort(scheme: string): number | undefined {
  return DEFAULT_PORTS[scheme];
}

const ABSOLUTE_FORM = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
/**
 * Scheme and userinfo of an absolute-form target. The userinfo runs to the last `@` before the
 * first `/` or `?`, so a `#` or `@` inside a password cannot end it early.
 */
const ABSOLUTE_USERINFO = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?]*@/;

/**
 * Builds the recorded URL from what a client request knows: its scheme (`http:`), host
 * (lowercased), port and request target (`/path?query`). The target's fragment is dropped and
 * listed query values are replaced by `REDACTED`. A target in absolute form (a request to a
 * forward proxy, `http://target/x`) has its userinfo removed before anything else and becomes
 * the URL itself; if it does not parse as a URL, only its path is kept (`splitUrl` drops scheme
 * and authority), never the raw string. Never throws.
 */
export function clientTarget(
  scheme: string,
  rawHost: string,
  port: number | undefined,
  rawTarget: string,
  queryKeys: ReadonlySet<string>,
): ClientTarget {
  const host = typeof rawHost === "string" ? rawHost.toLowerCase() : "";
  let target = typeof rawTarget === "string" ? rawTarget : "";
  const userinfo = ABSOLUTE_USERINFO.exec(target);
  if (userinfo !== null) {
    target = `${userinfo[1]}${target.slice(userinfo[0].length)}`;
  }
  const hash = target.indexOf("#");
  if (hash !== -1) target = target.slice(0, hash);
  const q = target.indexOf("?");
  let path = q === -1 ? target : target.slice(0, q);
  const query = q === -1 ? "" : redactQuery(target.slice(q + 1), queryKeys);
  const suffix = query === "" ? "" : `?${query}`;

  if (ABSOLUTE_FORM.test(path)) {
    try {
      const u = new URL(path);
      return {
        full: `${u.protocol}//${u.host}${u.pathname}${suffix}`,
        address: host,
        port,
      };
    } catch {
      // Not a URL: keep only the path, with scheme and authority dropped.
      path = splitUrl(path, queryKeys).path;
    }
  }
  if (path === "") path = "/";
  else if (!path.startsWith("/") && path !== "*") path = `/${path}`;
  const bracketed = host.includes(":") && !host.startsWith("[");
  const authority = bracketed ? `[${host}]` : host;
  const shownPort =
    port !== undefined && port !== defaultPort(scheme) ? `:${port}` : "";
  return {
    full: `${scheme}//${authority}${shownPort}${path}${suffix}`,
    address: host,
    port,
  };
}

/** `METHOD` for a known method, `HTTP` otherwise (semantic conventions). */
export function clientSpanName(method: string): string {
  return KNOWN_METHODS.has(method) ? method : "HTTP";
}

/** Attributes known when the request is created. */
export function requestAttributes(
  method: string,
  target: ClientTarget,
  headers: HeadersInput | null | undefined,
  config: OutboundConfig,
): Attributes {
  const attributes: Attributes = {
    [ATTR_URL_FULL]: target.full,
    [ATTR_SERVER_ADDRESS]: target.address,
  };
  if (KNOWN_METHODS.has(method)) {
    attributes[ATTR_HTTP_REQUEST_METHOD] = method;
  } else {
    attributes[ATTR_HTTP_REQUEST_METHOD] = HTTP_REQUEST_METHOD_VALUE_OTHER;
    attributes[ATTR_HTTP_REQUEST_METHOD_ORIGINAL] = method;
  }
  if (target.port !== undefined) attributes[ATTR_SERVER_PORT] = target.port;
  Object.assign(
    attributes,
    headerAttributes(headers, config.requestHeaders, REQUEST_HEADER_PREFIX),
  );
  return attributes;
}

/** Starts the client span under `parent`. The tracer is obtained here, at use time. */
export function startClientSpan(
  method: string,
  attributes: Attributes,
  parent: Context,
): Span {
  return trace
    .getTracer(TRACER_NAME)
    .startSpan(
      clientSpanName(method),
      { kind: SpanKind.CLIENT, attributes },
      parent,
    );
}

/** Records the response head: status code, allowlisted headers, error status from 400 on. */
export function recordResponseHead(
  span: Span,
  statusCode: number | undefined,
  headers: HeadersInput | null | undefined,
  config: OutboundConfig,
): void {
  if (typeof statusCode === "number" && Number.isFinite(statusCode)) {
    span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);
    if (statusCode >= 400) {
      span.setAttribute(ATTR_ERROR_TYPE, String(statusCode));
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
  }
  span.setAttributes(
    headerAttributes(headers, config.responseHeaders, RESPONSE_HEADER_PREFIX),
  );
}

/** A low-cardinality `error.type`: a string `code` (`ECONNREFUSED`), else the error's name. */
export function errorType(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name !== "") return name;
  }
  return ERROR_TYPE_VALUE_OTHER;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

/** Marks the span failed by `error` (an exception event, error status, `error.type`). */
export function recordClientError(
  span: Span,
  error: unknown,
  type = errorType(error),
): void {
  const message = errorMessage(error);
  if (error !== null && typeof error === "object") {
    span.recordException(error as Error);
  } else if (message !== undefined) {
    span.recordException(message);
  }
  span.setAttribute(ATTR_ERROR_TYPE, type);
  span.setStatus(
    message === undefined
      ? { code: SpanStatusCode.ERROR }
      : { code: SpanStatusCode.ERROR, message },
  );
}

// ---------------------------------------------------------------------------------------------
// Header injection
// ---------------------------------------------------------------------------------------------

/**
 * Injects the active propagator's headers for `span` into an outgoing request, through
 * `propagation.inject` (whatever propagator is registered: Nestrix's W3C one or the host's).
 * - When the request already has a `traceparent`, nothing is injected: the caller owns
 *   propagation for it, and a second `traceparent` (undici appends) or an overwrite (`node:http`
 *   replaces) both change what the caller sends.
 * - Otherwise each field is added only when the request does not already carry it, so a header
 *   another tool set (`baggage`) is neither duplicated nor overwritten.
 * - A failure to add a header is expected in one case (`node:http` with array headers throws
 *   `ERR_HTTP_HEADERS_SENT`) and leaves the request as the caller built it; it is not counted.
 */
export function injectContext(
  parent: Context,
  span: Span,
  has: (name: string) => boolean,
  add: (name: string, value: string) => void,
): void {
  if (has("traceparent")) return;
  try {
    propagation.inject(
      trace.setSpan(parent, span),
      {},
      {
        set(_carrier, key, value) {
          if (!has(key)) add(key, value);
        },
      },
    );
  } catch {
    // The request goes out unchanged, without our headers.
  }
}

// ---------------------------------------------------------------------------------------------
// Ending
// ---------------------------------------------------------------------------------------------

/** One client request's span. `ended` makes every end path idempotent. */
export interface ClientSpanState {
  readonly span: Span;
  ended: boolean;
}

/** Ends the span once; later calls do nothing. */
export function endOnce(state: ClientSpanState, endTime?: TimeInput): boolean {
  if (state.ended) return false;
  state.ended = true;
  state.span.end(endTime);
  return true;
}

/** Ends the span at `headAt` (epoch milliseconds) and marks the body as not consumed. */
export function endNotConsumed(state: ClientSpanState, headAt: number): void {
  if (state.ended) return;
  state.span.setAttribute(ATTR_NESTRIX_HTTP_BODY, BODY_NOT_CONSUMED);
  endOnce(state, headAt);
}

/** Ends the span now, marked as a body the caller cancelled after the head. No error status. */
export function endCancelled(state: ClientSpanState): void {
  if (state.ended) return;
  state.span.setAttribute(ATTR_NESTRIX_HTTP_BODY, BODY_CANCELLED);
  endOnce(state);
}

/** Epoch milliseconds with sub-millisecond precision, as `Span.end` reads a number. */
export function nowMillis(): number {
  return performance.timeOrigin + performance.now();
}
