/**
 * Client spans for the global `fetch` and for the `undici` npm package, from undici's
 * diagnostics channels (D-42; channel facts per Node version in research.md §3, "undici
 * diagnostics channels"). Diagnostics channels are looked up by name, so one subscription sees
 * every undici copy in the process: the one bundled in Node (behind `fetch`) and any npm copy.
 * - `undici:request:create`: decide (suppress key, active parent, ignore list), start the span
 *   with the caller's context, add the propagator's headers with `request.addHeader` when the
 *   request has no `traceparent`. Published in the caller's async context.
 * - `undici:request:headers`: the response head (status, headers).
 * - `undici:request:trailers`: the body was fully received; the span ends.
 * - `undici:request:error`: the span ends with the error.
 * - A body nobody reads: undici stops reading once its buffer is full, and neither `trailers`
 *   nor `error` comes (verified on Node 22.15, 24.22 and 26.13; undici's own `bodyTimeout` does
 *   not fire while the body is paused). The span would never end. So when the head arrives a
 *   timer of {@link UNREAD_BODY_GRACE_MILLIS} starts; `undici:request:bodyChunkReceived`
 *   restarts it where undici publishes that channel (Node 24+, undici 7+). If it fires first,
 *   the span ends at the head with `nestrix.http.body = "not consumed"`. The global `fetch`
 *   cancels an unread body when its `Response` is garbage-collected and publishes that as an
 *   `error` whose value is a string; that is treated the same way, not as a failure.
 * - After the head, an `error` that is the caller cancelling the body (`AbortError`, or a
 *   non-Error cancel reason) ends the span with `nestrix.http.body = "cancelled"` and no error
 *   status; before the head every error is an error.
 * - An upgrade (WebSocket) or CONNECT request on undici 6 (Node 22.15) publishes only `create`,
 *   so the same timer is armed at create and ends the span without a head if nothing follows.
 *
 * Every subscriber body catches everything (rule 1). Nothing here adds a listener to any undici
 * object; the only thing done to the request is `addHeader`.
 */
import { context } from "@opentelemetry/api";
import type { HeadersInput } from "../privacy.js";
import {
  type ClientSpanState,
  clientTarget,
  endCancelled,
  endNotConsumed,
  endOnce,
  fault,
  injectContext,
  isIgnored,
  nowMillis,
  type OutboundConfig,
  parentContext,
  recordClientError,
  recordResponseHead,
  requestAttributes,
  startClientSpan,
} from "./rules.js";

export const UNDICI_CHANNELS = {
  create: "undici:request:create",
  headers: "undici:request:headers",
  bodyChunkReceived: "undici:request:bodyChunkReceived",
  trailers: "undici:request:trailers",
  error: "undici:request:error",
} as const;

/**
 * How long after the response head (or the last body chunk, where undici reports chunks) a
 * request may go without finishing before its span is ended at the head as "not consumed".
 * A body that genuinely takes longer to arrive gets a head-only span (known limitation).
 */
export const UNREAD_BODY_GRACE_MILLIS = 30_000;

/** The parts of undici's `Request` read here (undici 6 to 8). Structural, no `instanceof`. */
interface UndiciRequestLike {
  readonly method: string;
  readonly origin: string | { toString(): string };
  readonly path: string;
  /** The protocol for an upgrade request (`"websocket"`), else `null`. */
  readonly upgrade?: string | null;
  /** A flat `[name, value, ...]` array in undici 6+, a raw header string in undici 5. */
  readonly headers: unknown;
  addHeader?(name: string, value: string): unknown;
}

interface UndiciState extends ClientSpanState {
  /** Epoch milliseconds of the response head, once seen. */
  headAt: number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function hasHeader(headers: unknown, name: string): boolean {
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      const n = headers[i];
      if (typeof n === "string" && n.toLowerCase() === name) return true;
    }
    return false;
  }
  if (typeof headers === "string") {
    const lower = headers.toLowerCase();
    return lower.startsWith(`${name}:`) || lower.includes(`\r\n${name}:`);
  }
  return false;
}

/** Fetch's garbage-collection cancel of an unread body publishes this string as the error. */
function isUnreadBodyCollected(error: unknown): boolean {
  return typeof error === "string" && error.includes("garbage collected");
}

/**
 * Whether an error after the response head is the caller cancelling the body, not a failure.
 * Measured on Node 22.15, 24.22 and 26.13 for `fetch` and `undici.request` (research.md,
 * "Cancel or cut after the response head"): `res.body.cancel()`, aborting the signal after the
 * head and destroying `undici.request`'s body publish an `AbortError`; `cancel(reason)` with a
 * non-Error reason publishes that value as is. A server or network cut publishes a `SocketError`
 * (`UND_ERR_SOCKET`). A caller aborting with an Error object of its own as the reason, or
 * `AbortSignal.timeout()` (`TimeoutError`), stays an error.
 */
function isCancelledByCaller(error: unknown): boolean {
  if (error === null || typeof error !== "object") return true;
  return (error as { name?: unknown }).name === "AbortError";
}

export interface UndiciSubscriberOptions {
  /** Tests only: a shorter grace than {@link UNREAD_BODY_GRACE_MILLIS}. */
  readonly unreadGraceMillis?: number;
}

export function subscribeUndici(
  config: OutboundConfig,
  options: UndiciSubscriberOptions = {},
): {
  channels: Record<string, (message: unknown, name: string | symbol) => void>;
} {
  const states = new WeakMap<object, UndiciState>();
  const { diagnostics } = config;
  const grace = options.unreadGraceMillis ?? UNREAD_BODY_GRACE_MILLIS;

  const clearTimer = (state: UndiciState): void => {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  };

  const armTimer = (state: UndiciState): void => {
    const timer = setTimeout(() => {
      try {
        fault("undici.unconsumed");
        state.timer = undefined;
        if (state.headAt !== undefined) endNotConsumed(state, state.headAt);
        // Armed at create for an upgrade or CONNECT request, and no head came (undici 6:
        // Node 22.15's WebSocket publishes only `create`). The end time is when the timer
        // fires, so the span's duration is the grace, not the request's.
        else endOnce(state);
      } catch (error) {
        diagnostics.countFailure("outbound.undici.unconsumed", error);
      }
    }, grace);
    timer.unref?.();
    state.timer = timer;
  };

  const onCreate = (message: unknown): void => {
    try {
      fault("undici.create");
      const request = (message as { request: UndiciRequestLike }).request;
      const parent = parentContext(context.active());
      if (parent === undefined) return;
      const origin = new URL(String(request.origin));
      const port =
        origin.port === ""
          ? origin.protocol === "https:"
            ? 443
            : origin.protocol === "http:"
              ? 80
              : undefined
          : Number(origin.port);
      const host = origin.hostname.startsWith("[")
        ? origin.hostname.slice(1, -1)
        : origin.hostname;
      const target = clientTarget(
        origin.protocol,
        host,
        port,
        request.path,
        config.queryKeys,
      );
      if (isIgnored(target.full, config)) return;
      const method = request.method;
      const headers = request.headers;
      const span = startClientSpan(
        method,
        requestAttributes(
          method,
          target,
          Array.isArray(headers) ? (headers as HeadersInput) : undefined,
          config,
        ),
        parent,
      );
      const state: UndiciState = {
        span,
        ended: false,
        headAt: undefined,
        timer: undefined,
      };
      states.set(request, state);
      // undici 6 (Node 22.15) publishes nothing after `create` for an upgrade (WebSocket) or
      // CONNECT request: no head, no trailers, no error. Without this the span never ends.
      // undici 7+ publishes `headers` and `trailers` from `onUpgrade`, which clear the timer.
      if (request.upgrade || method === "CONNECT") armTimer(state);
      if (typeof request.addHeader === "function") {
        injectContext(
          parent,
          span,
          (name) => hasHeader(request.headers, name),
          (name, value) => {
            request.addHeader?.(name, value);
          },
        );
      }
    } catch (error) {
      diagnostics.countFailure("outbound.undici.create", error);
    }
  };

  const onHeaders = (message: unknown): void => {
    try {
      fault("undici.headers");
      const { request, response } = message as {
        request: object;
        response: { statusCode?: number; headers?: HeadersInput };
      };
      const state = states.get(request);
      if (state === undefined || state.ended) return;
      recordResponseHead(
        state.span,
        response.statusCode,
        response.headers,
        config,
      );
      state.headAt = nowMillis();
      clearTimer(state);
      armTimer(state);
    } catch (error) {
      diagnostics.countFailure("outbound.undici.headers", error);
    }
  };

  const onBodyChunk = (message: unknown): void => {
    try {
      fault("undici.chunk");
      const state = states.get((message as { request: object }).request);
      if (state === undefined || state.ended || state.timer === undefined)
        return;
      state.timer.refresh();
    } catch (error) {
      diagnostics.countFailure("outbound.undici.chunk", error);
    }
  };

  const onTrailers = (message: unknown): void => {
    try {
      fault("undici.trailers");
      const state = states.get((message as { request: object }).request);
      if (state === undefined) return;
      clearTimer(state);
      endOnce(state);
    } catch (error) {
      diagnostics.countFailure("outbound.undici.trailers", error);
    }
  };

  const onError = (message: unknown): void => {
    try {
      fault("undici.error");
      const { request, error } = message as { request: object; error: unknown };
      const state = states.get(request);
      if (state === undefined) return;
      clearTimer(state);
      if (state.ended) return;
      if (state.headAt !== undefined && isUnreadBodyCollected(error)) {
        endNotConsumed(state, state.headAt);
        return;
      }
      if (state.headAt !== undefined && isCancelledByCaller(error)) {
        endCancelled(state);
        return;
      }
      recordClientError(state.span, error);
      endOnce(state);
    } catch (err) {
      diagnostics.countFailure("outbound.undici.error", err);
    }
  };

  return {
    channels: {
      [UNDICI_CHANNELS.create]: onCreate,
      [UNDICI_CHANNELS.headers]: onHeaders,
      [UNDICI_CHANNELS.bodyChunkReceived]: onBodyChunk,
      [UNDICI_CHANNELS.trailers]: onTrailers,
      [UNDICI_CHANNELS.error]: onError,
    },
  };
}
