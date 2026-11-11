/**
 * Client spans for `node:http` and `node:https` from Node's built-in diagnostics channels
 * (architecture §4.2 "Outbound HTTP", the mechanism proven in spike P0-S2):
 * - `http.client.request.created`: decide (suppress key, active parent, ignore list), start the
 *   span with the caller's context, inject the propagator's headers when the request has no
 *   `traceparent`. Published synchronously inside `http.request()`, in the caller's context.
 * - `http.client.response.finish`: the response head. Record status and headers, then end the
 *   span on the response's `close` (an incomplete response is an error), or at the head when,
 *   on the next `setImmediate`, nothing consumes the body (else `close` never comes).
 * - `http.client.request.error`: end with the error.
 *
 * Every subscriber body catches everything (rule 1): a throw in a diagnostics-channel
 * subscriber becomes `uncaughtException`. No `'error'` listener is ever added; the only
 * listener is a `'close'` on the response, which changes neither flowing mode nor error handling.
 */
import { context } from "@opentelemetry/api";
import type { HeadersInput } from "../privacy.js";
import {
  type ClientSpanState,
  clientTarget,
  defaultPort,
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

export const NODE_HTTP_CHANNELS = {
  created: "http.client.request.created",
  responseFinish: "http.client.response.finish",
  error: "http.client.request.error",
} as const;

/** The parts of `http.ClientRequest` read here. Structural: no `instanceof` anywhere. */
interface ClientRequestLike {
  readonly method: string;
  readonly path: string;
  readonly host: string;
  readonly protocol: string;
  readonly socketPath?: string | undefined;
  getHeader(name: string): unknown;
  getHeaders(): HeadersInput;
  hasHeader(name: string): boolean;
  setHeader(name: string, value: string): unknown;
  once(event: "close", listener: () => void): unknown;
}

/** The parts of `http.IncomingMessage` read here. */
interface IncomingMessageLike {
  readonly statusCode?: number | undefined;
  readonly headers: HeadersInput;
  readonly complete: boolean;
  readonly readableFlowing: boolean | null;
  readonly readableEnded: boolean;
  readonly errored?: unknown;
  readonly socket?: {
    readonly readableEnded?: boolean;
    readonly errored?: unknown;
  } | null;
  listenerCount(event: string): number;
  once(event: "close", listener: () => void): unknown;
}

/**
 * Whether an incomplete response ended because the caller cancelled it after the head
 * (`req.destroy()`, `res.destroy()`), as opposed to the server or the network cutting it.
 * Measured on Node 22.15, 24.22 and 26.13 (research.md, "Cancel or cut after the response
 * head"): the response looks the same in both cases (`ECONNRESET`), but the socket does not.
 * After a server close it has ended (`readableEnded`), after a reset or a caller's
 * `destroy(error)` it carries an error, and after a caller's plain destroy it has neither.
 * Without a socket to look at, the answer is no, and the incomplete response stays an error.
 */
function cancelledByCaller(response: IncomingMessageLike): boolean {
  const socket = response.socket;
  if (socket === null || socket === undefined) return false;
  return socket.readableEnded === false && !socket.errored;
}

/**
 * The port the request connects to. `ClientRequest` exposes none, but Node writes
 * `host[:port]` into the `Host` header (port only when not the scheme's default) unless the
 * caller set `Host` itself. So: when the header names the same host, its port (or the default)
 * is the port; when the caller overrode `Host`, or the request goes to a Unix socket, the port is
 * unknown and left out.
 */
function portOf(
  request: ClientRequestLike,
  scheme: string,
): number | undefined {
  if (request.socketPath) return undefined;
  const header = request.getHeader("host");
  if (typeof header !== "string") return undefined;
  let hostPart: string;
  let portPart: string | undefined;
  if (header.startsWith("[")) {
    const close = header.indexOf("]");
    if (close === -1) return undefined;
    hostPart = header.slice(1, close);
    const rest = header.slice(close + 1);
    portPart = rest.startsWith(":") ? rest.slice(1) : undefined;
  } else {
    const colon = header.lastIndexOf(":");
    // A bare IPv6 address would have several colons; Node always brackets it.
    hostPart = colon === -1 ? header : header.slice(0, colon);
    portPart = colon === -1 ? undefined : header.slice(colon + 1);
  }
  const host = request.host.startsWith("[")
    ? request.host.slice(1, -1)
    : request.host;
  if (hostPart.toLowerCase() !== host.toLowerCase()) return undefined;
  if (portPart === undefined || portPart === "") return defaultPort(scheme);
  const port = Number(portPart);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

interface NodeHttpState extends ClientSpanState {
  /** `http.client.response.finish` was seen. */
  head: boolean;
}

export function subscribeNodeHttp(config: OutboundConfig): {
  channels: Record<string, (message: unknown, name: string | symbol) => void>;
} {
  const states = new WeakMap<object, NodeHttpState>();
  const { diagnostics } = config;

  const onCreated = (message: unknown): void => {
    try {
      fault("node-http.created");
      const request = (message as { request: ClientRequestLike }).request;
      const parent = parentContext(context.active());
      if (parent === undefined) return;
      const scheme = request.protocol;
      const target = clientTarget(
        scheme,
        request.host,
        portOf(request, scheme),
        request.path,
        config.queryKeys,
      );
      if (isIgnored(target.full, config)) return;
      const method = request.method;
      const span = startClientSpan(
        method,
        requestAttributes(method, target, request.getHeaders(), config),
        parent,
      );
      const state: NodeHttpState = { span, ended: false, head: false };
      states.set(request, state);
      // Last resort for requests that never get a response head through the channels (an
      // 'upgrade' or 'connect' response): end when the request closes. A request that got a
      // head ends on the response's 'close' or at the head instead, both before or without this.
      request.once("close", () => {
        try {
          fault("node-http.request-close");
          if (!state.head) endOnce(state);
        } catch (error) {
          diagnostics.countFailure("outbound.node-http.request-close", error);
        }
      });
      injectContext(
        parent,
        span,
        (name) => request.hasHeader(name),
        (name, value) => {
          request.setHeader(name, value);
        },
      );
    } catch (error) {
      diagnostics.countFailure("outbound.node-http.created", error);
    }
  };

  const onResponseFinish = (message: unknown): void => {
    try {
      fault("node-http.response");
      const { request, response } = message as {
        request: object;
        response: IncomingMessageLike;
      };
      const state = states.get(request);
      if (state === undefined || state.ended) return;
      state.head = true;
      recordResponseHead(
        state.span,
        response.statusCode,
        response.headers,
        config,
      );
      const headAt = nowMillis();
      response.once("close", () => {
        try {
          fault("node-http.close");
          if (state.ended) return;
          if (!response.complete && cancelledByCaller(response)) {
            endCancelled(state);
            return;
          }
          if (!response.complete) {
            const cause = response.errored;
            recordClientError(
              state.span,
              cause ?? new Error("response body incomplete"),
              cause ? undefined : "response_incomplete",
            );
          }
          endOnce(state);
        } catch (error) {
          diagnostics.countFailure("outbound.node-http.close", error);
        }
      });
      // `response.finish` is published just before the request emits 'response', so by the next
      // turn of the event loop the caller's response callback has run. If nothing consumes the
      // body by then (not flowing, no 'readable' listener), 'close' never comes: end at the head.
      // A caller that starts reading on a later tick gets a head-only span (known limitation).
      setImmediate(() => {
        try {
          fault("node-http.unconsumed");
          if (state.ended) return;
          const consuming =
            response.readableFlowing !== null ||
            response.listenerCount("readable") > 0 ||
            response.readableEnded;
          if (!consuming) endNotConsumed(state, headAt);
        } catch (error) {
          diagnostics.countFailure("outbound.node-http.unconsumed", error);
        }
      });
    } catch (error) {
      diagnostics.countFailure("outbound.node-http.response", error);
    }
  };

  const onError = (message: unknown): void => {
    try {
      fault("node-http.error");
      const { request, error } = message as { request: object; error: unknown };
      const state = states.get(request);
      if (state === undefined || state.ended) return;
      recordClientError(state.span, error);
      endOnce(state);
    } catch (err) {
      diagnostics.countFailure("outbound.node-http.error", err);
    }
  };

  return {
    channels: {
      [NODE_HTTP_CHANNELS.created]: onCreated,
      [NODE_HTTP_CHANNELS.responseFinish]: onResponseFinish,
      [NODE_HTTP_CHANNELS.error]: onError,
    },
  };
}
