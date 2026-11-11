/**
 * Nestrix's per-request state for an HTTP server span (architecture §4.2).
 *
 * It is reachable two ways, and both are Nestrix's own:
 * - through a context key Nestrix owns, for the route-triggered hook, which receives no
 *   request object (never `trace.getActiveSpan()`, which may be another tool's span: P0-S3 Q4c');
 * - through the raw `IncomingMessage`, for the interceptor, which has the request but may run
 *   in a context another tool replaced (P0-S3 Q4c: Sentry's Express instrumentation).
 *
 * Imports `@opentelemetry/api` only (AGENTS.md rule 5). Nothing here throws.
 */
import { type Context, createContextKey, type Span } from "@opentelemetry/api";

export interface RequestState {
  /** Nestrix's server span. Only Nestrix's own code touches it. */
  readonly span: Span;
  /** The request method as received, upper-cased; used for the span name. */
  readonly method: string;
  /**
   * The span name when there is no route: the method, or `HTTP` for a method outside the
   * semantic conventions' list.
   */
  readonly baseName: string;
  /** Last route template the route-triggered hook reported. Applied at `close`. */
  route: string | undefined;
  /** Set by the interceptor (P1-07): the request reached Nestrix's global interceptor. */
  reached: boolean;
  /**
   * Set by the interceptor when a handler or pipe threw: the status that exception maps to
   * (an `HttpException`'s own, otherwise 500) and its type name. The exception itself is
   * already recorded on the span as an event.
   */
  exception: { status: number; type: string } | undefined;
  /** Set once the span has ended, so a second `close` path cannot end it twice. */
  ended: boolean;
  /**
   * `performance.now()` when the request hook ran, for route statistics (P2-04). Set only when
   * statistics are on (the dashboard is on); `0` otherwise, with no clock read.
   */
  startedAt?: number;
}

/**
 * The minimal state of a request under the dashboard path (P2-04). Such a request has no span,
 * no `RequestState` and no route statistics; it is not reachable through the context key, so
 * the route hook and the interceptor ignore it.
 */
export interface DashboardRequestState {
  /** Set by a Nestrix dashboard handler (P2-06) through `markDashboardHandlerReached`. */
  handlerReached: boolean;
  /** Set once the `close` check has run. */
  closed: boolean;
}

/**
 * The context key. `createContextKey` uses `Symbol.for(description)`, so the description is
 * namespaced to make a collision with another tool's key implausible.
 */
export const REQUEST_STATE_KEY = createContextKey(
  "@nestrix/nestjs http server request state",
);

/** Raw `IncomingMessage` to its state. Weak, so a request never outlives its socket here. */
const byRequest = new WeakMap<object, RequestState>();

export function getStateFromContext(ctx: Context): RequestState | undefined {
  try {
    const value = ctx.getValue(REQUEST_STATE_KEY);
    return isState(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function setStateForRequest(
  rawRequest: object,
  state: RequestState,
): void {
  byRequest.set(rawRequest, state);
}

/**
 * Finds the state from whatever request object a Nest execution context holds: the raw
 * `IncomingMessage` (Express, platform-node) or a wrapper carrying it as `raw` (Fastify).
 */
export function getStateForRequest(request: unknown): RequestState | undefined {
  try {
    if (request === null || typeof request !== "object") return undefined;
    const direct = byRequest.get(request);
    if (direct) return direct;
    const raw = (request as { raw?: unknown }).raw;
    if (raw !== null && typeof raw === "object") return byRequest.get(raw);
  } catch {
    // A request object with a throwing `raw` getter: no state.
  }
  return undefined;
}

/** Raw `IncomingMessage` under the dashboard path to its minimal state. */
const dashboardByRequest = new WeakMap<object, DashboardRequestState>();

export function setDashboardStateForRequest(
  rawRequest: object,
  state: DashboardRequestState,
): void {
  dashboardByRequest.set(rawRequest, state);
}

/**
 * For P2-06's dashboard handlers: marks that a Nestrix dashboard handler is answering this
 * request, so the `close` check does not report it as shadowed. Accepts the request object an
 * adapter hands a handler: the raw `IncomingMessage` (Express, platform-node) or a wrapper
 * carrying it as `raw` (Fastify). Does nothing for a request the hook did not see as a
 * dashboard request (dashboard off, or a path that only matched the router case-insensitively).
 * Never throws.
 */
export function markDashboardHandlerReached(request: unknown): void {
  try {
    if (request === null || typeof request !== "object") return;
    let state = dashboardByRequest.get(request);
    if (state === undefined) {
      const raw = (request as { raw?: unknown }).raw;
      if (raw !== null && typeof raw === "object") {
        state = dashboardByRequest.get(raw);
      }
    }
    if (state !== undefined) state.handlerReached = true;
  } catch {
    // A request object with a throwing `raw` getter: nothing to mark.
  }
}

function isState(value: unknown): value is RequestState {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as RequestState).span === "object" &&
    typeof (value as RequestState).method === "string"
  );
}

/**
 * Internal fault-injection seam for tests (P1-10's injected-fault row). Not exported from
 * `src/index.ts` and not public API. Setting `site` makes the Nestrix code at that site throw
 * inside its own guard, so a test can show the host request is unaffected.
 */
export type FaultSite =
  | "request-hook"
  | "route-hook"
  | "close-listener"
  | "interceptor"
  | "interceptor-error"
  | "init-subscriber"
  | "process-monitor"
  | "stats-record"
  | "dashboard-close"
  | "user";

export const faultInjection: { site: FaultSite | undefined } = {
  site: undefined,
};

/** Throws when `site` is the injected one. Call it inside the guard it is meant to test. */
export function maybeFault(site: FaultSite): void {
  if (faultInjection.site === site) {
    throw new Error(`Nestrix injected fault at ${site}`);
  }
}
