// Stand-in for Nestrix's level-1 instrumentation. Imports @opentelemetry/api only
// (AGENTS.md rule 5) plus Nest's public API. Plain ESM JavaScript so a CommonJS host
// can require() it exactly as it would require() the ESM-only @nestrix/nestjs, and so
// it runs without a build step. Decorators are applied as functions.
//
// Every hook and subscriber body catches everything (rule 1). Fault injection: set
// globalThis.__nestrixFault to "request-hook", "route-hook" or "http-subscriber" and
// that body throws on purpose inside its guard.
//
// Two rules from the P0-S3 review:
// - The route hook touches only Nestrix's own server span, found through a context
//   key Nestrix owns, never `trace.getActiveSpan()` (which may be another tool's span).
//   The route is also kept in Nestrix's own per-request state, because `updateName`
//   on a non-recording (sampled-out) span does nothing, and pre-sampling route
//   statistics must not depend on the span.
// - The node:http subscriber creates no client span and injects no header when
//   tracing is suppressed (OpenTelemetry's suppress-tracing context key, which SDK
//   exporters set around their own requests) or when there is no active parent span.

import dc from "node:diagnostics_channel";
import { Inject, Injectable, Module, RequestMethod } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import {
  context,
  createContextKey,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

const TRACER_NAME = "nestrix-standin";
const tracer = () => trace.getTracer(TRACER_NAME);

/** Nestrix's own per-request state: `{ span, route }`. */
const NESTRIX_REQUEST = createContextKey("nestrix.standin.request");
/**
 * The key @opentelemetry/core's suppressTracing() sets. createContextKey uses
 * Symbol.for(description), so the same description gives the same key in every copy
 * of the api, without importing @opentelemetry/core.
 */
const SUPPRESS_TRACING = createContextKey(
  "OpenTelemetry SDK Context Key SUPPRESS_TRACING",
);

/** Counts of swallowed failures, per hook. A real implementation logs once. */
export const faults = {
  requestHook: 0,
  routeHook: 0,
  closeListener: 0,
  httpSubscriber: 0,
};

/** Requests per "METHOD route", counted on `close` whatever the sampling decision. */
export const routeStats = {};

/** Why the node:http subscriber skipped a request. */
export const httpSkips = { suppressed: 0, noParent: 0 };

function maybeFault(name) {
  if (globalThis.__nestrixFault === name) {
    throw new Error(`injected fault in ${name}`);
  }
}

const headerGetter = {
  keys: (carrier) => Object.keys(carrier ?? {}),
  get: (carrier, key) => {
    const value = carrier?.[key];
    return Array.isArray(value) ? value[0] : value;
  },
};

/**
 * The request hook: extract W3C context, start the server span, end it on the raw
 * response's `close`, and call `done()` exactly once inside the span's context.
 */
export function createRequestHook() {
  return function nestrixRequestHook(req, res, done) {
    let ctx;
    try {
      maybeFault("request-hook");
      const rawReq = req?.raw ?? req;
      const rawRes = res?.raw ?? res;
      const method = String(rawReq?.method ?? "GET").toUpperCase();
      const parent = propagation.extract(
        context.active(),
        rawReq?.headers ?? {},
        headerGetter,
      );
      const span = tracer().startSpan(
        method,
        {
          kind: SpanKind.SERVER,
          attributes: {
            "http.request.method": method,
            "url.path": String(rawReq?.url ?? "").split("?")[0],
          },
        },
        parent,
      );
      const state = { span, method, route: undefined };
      rawRes?.once?.("close", () => {
        try {
          const key = state.route ? `${method} ${state.route}` : method;
          routeStats[key] = (routeStats[key] ?? 0) + 1;
          const status = rawRes.statusCode;
          span.setAttribute("http.response.status_code", status);
          if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
        } catch {
          faults.closeListener++;
        }
      });
      ctx = trace.setSpan(parent, span).setValue(NESTRIX_REQUEST, state);
    } catch {
      faults.requestHook++;
      ctx = undefined;
    }
    if (!ctx) return done();
    let called = false;
    try {
      return context.with(ctx, () => {
        called = true;
        return done();
      });
    } catch (error) {
      if (!called) return done();
      throw error; // thrown by Nest's own continuation, not by us
    }
  };
}

export function createRouteTriggeredHook(previous) {
  return function nestrixRouteTriggered(requestMethod, path) {
    try {
      maybeFault("route-hook");
      if (globalThis.__nestrixRouteLegacy) {
        // Spike-only: the pre-review behaviour, kept to show the test catches it.
        const active = trace.getActiveSpan();
        active?.updateName(`${RequestMethod[requestMethod] ?? "GET"} ${path}`);
        return previous?.(requestMethod, path);
      }
      const state = context.active().getValue(NESTRIX_REQUEST);
      if (state) {
        state.route = path;
        const method = RequestMethod[requestMethod] ?? state.method;
        if (state.span.isRecording()) {
          state.span.updateName(`${method} ${path}`);
          state.span.setAttribute("http.route", path);
        }
      }
    } catch {
      faults.routeHook++;
    }
    return previous?.(requestMethod, path);
  };
}

/** Sets the hooks from a provider constructor, as architecture.md §4.2 describes. */
export class NestrixHooks {
  constructor(adapterHost) {
    this.installed = false;
    try {
      const adapter = adapterHost?.httpAdapter;
      if (!adapter) return;
      adapter.setOnRequestHook(createRequestHook());
      const previous = adapter.getOnRouteTriggered?.();
      adapter.setOnRouteTriggered(createRouteTriggeredHook(previous));
      this.installed = true;
    } catch {
      faults.requestHook++;
    }
  }
}
Injectable()(NestrixHooks);
Inject(HttpAdapterHost)(NestrixHooks, undefined, 0);

export class NestrixStandInModule {}
Module({ providers: [NestrixHooks] })(NestrixStandInModule);

// node:http client spans: a subscriber on Node's built-in channels (the first-party
// piece in architecture.md §4.2). Injection from `http.client.request.created` is
// itself spike P0-S2's question; here it is used, and the downstream server records
// what actually arrived.
const clientSpans = new WeakMap();
const headerSetter = {
  set: (request, key, value) => request.setHeader(key, value),
};

function onClientRequestCreated(message) {
  try {
    maybeFault("http-subscriber");
    const request = message?.request;
    if (!request || clientSpans.has(request)) return;
    const active = context.active();
    if (active.getValue(SUPPRESS_TRACING) === true) {
      httpSkips.suppressed++;
      return;
    }
    if (!trace.getSpan(active)) {
      httpSkips.noParent++;
      return;
    }
    const method = String(request.method ?? "GET").toUpperCase();
    const span = tracer().startSpan(method, {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": method,
        "server.address": String(request.host ?? ""),
        "url.path": String(request.path ?? ""),
      },
    });
    clientSpans.set(request, span);
    propagation.inject(trace.setSpan(active, span), request, headerSetter);
  } catch {
    faults.httpSubscriber++;
  }
}

function onClientResponseFinish(message) {
  try {
    const span = clientSpans.get(message?.request);
    if (!span) return;
    span.setAttribute(
      "http.response.status_code",
      message.response?.statusCode ?? 0,
    );
    span.end();
    clientSpans.delete(message.request);
  } catch {
    faults.httpSubscriber++;
  }
}

function onClientRequestError(message) {
  try {
    const span = clientSpans.get(message?.request);
    if (!span) return;
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    clientSpans.delete(message.request);
  } catch {
    faults.httpSubscriber++;
  }
}

let httpSubscribed = false;
export function subscribeHttpClient() {
  if (httpSubscribed) return;
  httpSubscribed = true;
  dc.subscribe("http.client.request.created", onClientRequestCreated);
  dc.subscribe("http.client.response.finish", onClientResponseFinish);
  dc.subscribe("http.client.request.error", onClientRequestError);
}
