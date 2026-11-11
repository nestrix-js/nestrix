import dc from "node:diagnostics_channel";
import type { ClientRequest, IncomingMessage } from "node:http";
import {
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { maybeFault, noteFailure } from "./guard.js";

// First-party node:http client spans from Node's built-in channels (no patching).
// Spike instrumentation: it records which channels fired, in order, on the span
// (`nestrix.http.events`) so the tests can see the lifecycle per Node version.

interface State {
  span: Span;
  events: string[];
  ended: boolean;
}

const states = new WeakMap<ClientRequest, State>();
const tracer = () => trace.getTracer("nestrix-spike-http-client");

export interface HttpClientOptions {
  /** End the span on the request's `close` event if neither finish nor error came. */
  closeFallback?: boolean;
  /**
   * `headers`: end on `http.client.response.finish` (fires when the response head is
   * parsed). `body` (default): on that channel, attach a `close` listener to the
   * response and end there; an incomplete response is recorded as an error.
   */
  endOn?: "headers" | "body";
  /** Replace a `traceparent` the caller set itself (default false: leave it alone). */
  overwriteTraceparent?: boolean;
}

export const httpChannelsSeen: Record<string, number> = {};

function seen(name: string): void {
  httpChannelsSeen[name] = (httpChannelsSeen[name] ?? 0) + 1;
}

function end(state: State, how: string, error?: unknown): void {
  if (state.ended) return;
  state.ended = true;
  if (error !== undefined) {
    state.span.recordException(error as Error);
    state.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  state.span.setAttribute("nestrix.http.events", state.events.join(","));
  state.span.setAttribute("nestrix.http.ended_by", how);
  state.span.end();
}

function urlOf(req: ClientRequest): string {
  const host = req.getHeader("host") ?? req.host;
  // Query string dropped: values are not recorded by default (rule 7).
  const path = (req.path ?? "/").split("?")[0];
  return `${req.protocol}//${String(host)}${path}`;
}

let enabled = false;

export function enableHttpClient(options: HttpClientOptions = {}): void {
  if (enabled) return;
  enabled = true;

  dc.subscribe("http.client.request.created", (message) => {
    seen("http.client.request.created");
    try {
      maybeFault("http.created");
      const { request } = message as { request: ClientRequest };
      const parent = context.active();
      const span = tracer().startSpan(
        request.method,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "http.request.method": request.method,
            "url.full": urlOf(request),
          },
        },
        parent,
      );
      const state: State = { span, events: ["created"], ended: false };
      states.set(request, state);
      let injected = false;
      if (!options.overwriteTraceparent && request.hasHeader("traceparent")) {
        span.setAttribute(
          "nestrix.http.inject_skipped",
          "caller set traceparent",
        );
      } else {
        try {
          propagation.inject(trace.setSpan(parent, span), request, {
            set(carrier, key, value) {
              carrier.setHeader(key, value);
              injected = true;
            },
          });
        } catch (err) {
          span.setAttribute(
            "nestrix.http.inject_error",
            err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          );
          noteFailure("http.inject");
        }
      }
      span.setAttribute("nestrix.http.injected", injected);
      if (options.closeFallback) {
        request.once("close", () => {
          try {
            state.events.push("close");
            end(state, "close-fallback");
          } catch {
            noteFailure("http.close");
          }
        });
      }
    } catch {
      noteFailure("http.created");
    }
  });

  dc.subscribe("http.client.request.start", (message) => {
    seen("http.client.request.start");
    try {
      const { request } = message as { request: ClientRequest };
      states.get(request)?.events.push("start");
    } catch {
      noteFailure("http.start");
    }
  });

  dc.subscribe("http.client.response.finish", (message) => {
    seen("http.client.response.finish");
    try {
      maybeFault("http.finish");
      const { request, response } = message as {
        request: ClientRequest;
        response: IncomingMessage;
      };
      const state = states.get(request);
      if (!state) return;
      state.events.push("response.finish");
      const status = response.statusCode ?? 0;
      state.span.setAttribute("http.response.status_code", status);
      if (status >= 400) state.span.setStatus({ code: SpanStatusCode.ERROR });
      if (options.endOn === "headers") {
        end(state, "response.finish");
        return;
      }
      // A caller that never reads the body leaves the response paused: 'close' never
      // comes and the span would never end (review F2). `response.finish` is published
      // just before the request emits 'response', so by the next setImmediate the
      // caller's response callback has run. If by then nobody consumes the body
      // (no flowing mode, no 'readable' listener), end at the head and say so.
      setImmediate(() => {
        try {
          if (state.ended) return;
          const consuming =
            response.readableFlowing !== null ||
            response.listenerCount("readable") > 0 ||
            response.readableEnded;
          if (!consuming) {
            state.events.push("response.unconsumed");
            state.span.setAttribute("nestrix.http.body", "not consumed");
            end(state, "response.unconsumed");
          }
        } catch {
          noteFailure("http.response.unconsumed");
        }
      });
      // A 'close' listener changes neither flowing mode nor error handling.
      response.once("close", () => {
        try {
          state.events.push(
            response.complete ? "response.close" : "response.close(incomplete)",
          );
          end(
            state,
            "response.close",
            response.complete
              ? undefined
              : new Error("response aborted before end"),
          );
        } catch {
          noteFailure("http.response.close");
        }
      });
    } catch {
      noteFailure("http.finish");
    }
  });

  dc.subscribe("http.client.request.error", (message) => {
    seen("http.client.request.error");
    try {
      const { request, error } = message as {
        request: ClientRequest;
        error: unknown;
      };
      const state = states.get(request);
      if (!state) return;
      state.events.push("request.error");
      end(state, "request.error", error);
    } catch {
      noteFailure("http.error");
    }
  });
}
