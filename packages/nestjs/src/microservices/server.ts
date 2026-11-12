/**
 * Handler spans for `@MessagePattern` (SERVER) and `@EventPattern` (CONSUMER) handlers (backlog
 * P4-01, spike P4-S1 Q2).
 *
 * Two entry points run the same code:
 * - Nestrix's global interceptor, which Nest applies to microservice handlers in a microservice
 *   app and in a hybrid app's microservice connected with `inheritAppConfig: true`;
 * - `nestrixPreRequestHook`, which the user registers on a hybrid app's microservice
 *   (`connectMicroservice(options, { deferInitialization: true }).registerPreRequestHook(...)`,
 *   D-38), because a hybrid app's microservice otherwise gets a fresh application config and no
 *   module-registered global interceptor. The hook runs before guards, so it also covers
 *   messages a guard rejects.
 * When both run for one message, the first one traces it and the second passes through.
 *
 * The span is parented on the W3C context read from the packet metadata (`getMetadata()` on the
 * RPC context), started before the handler's stream is created, made active for it (Nest binds
 * the handler's async scope when `next.handle()` / `next()` is called), and ended when that stream
 * completes, errors or is unsubscribed. An error is recorded and sets error status; it reaches
 * Nest unchanged. Everything that is Nestrix's own is guarded; the handler's stream is created
 * exactly once, outside the guard.
 */
import type { ExecutionContext } from "@nestjs/common";
import {
  type Context,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  ATTR_CODE_FUNCTION_NAME,
  ATTR_ERROR_TYPE,
} from "@opentelemetry/semantic-conventions";
import { Observable, tap } from "rxjs";
import { diagnostics } from "../diagnostics.js";
import { endNestrixSpan, startNestrixSpan } from "../trace-limit.js";
import {
  ATTR_MESSAGING_DESTINATION_NAME,
  ATTR_MESSAGING_OPERATION_TYPE,
  ATTR_MESSAGING_SYSTEM,
  fault,
  MESSAGING_OPERATION_PROCESS,
  metadataGetter,
  microservicesActive,
  normalizePattern,
  readMetadata,
  serverTransport,
  spanName,
  TRACER_NAME,
} from "./shared.js";

// `@nestjs/microservices` metadata keys (`constants.js`) and `PatternHandler.EVENT`, read with
// `Reflect.getMetadata` so the package is not imported.
const PATTERN_METADATA = "microservices:pattern";
const PATTERN_HANDLER_METADATA = "microservices:handler_type";
const PATTERN_HANDLER_EVENT = 2;

/**
 * Messages already traced, by RPC context object and then handler: the event handlers of one
 * pattern share one context object, so the context alone does not identify a handler call.
 */
const traced = new WeakMap<object, WeakSet<object>>();

function alreadyTraced(rpcContext: unknown, handler: object): boolean {
  if (rpcContext === null || typeof rpcContext !== "object") return false;
  return traced.get(rpcContext)?.has(handler) === true;
}

function markTraced(rpcContext: unknown, handler: object): void {
  if (rpcContext === null || typeof rpcContext !== "object") return;
  let handlers = traced.get(rpcContext);
  if (handlers === undefined) {
    handlers = new WeakSet();
    traced.set(rpcContext, handlers);
  }
  handlers.add(handler);
}

/** The concrete pattern a transport context reports, used only to pick among several declared. */
function concretePattern(rpcContext: unknown): string | undefined {
  if (rpcContext === null || typeof rpcContext !== "object") return undefined;
  for (const getter of [
    "getPattern",
    "getSubject",
    "getChannel",
    "getTopic",
  ] as const) {
    const fn = (rpcContext as Record<string, unknown>)[getter];
    if (typeof fn === "function") {
      const value: unknown = fn.call(rpcContext);
      if (typeof value === "string") return value;
    }
  }
  return undefined;
}

/**
 * The declared pattern of the handler (low cardinality, like `http.route`): the only one, or, for
 * a handler with several, the one the transport reports, else the first.
 */
function declaredPattern(handler: object, rpcContext: unknown): string {
  const declared: unknown = Reflect.getMetadata(PATTERN_METADATA, handler);
  const patterns = Array.isArray(declared)
    ? declared.map(normalizePattern)
    : [];
  if (patterns.length === 1) return patterns[0] as string;
  const concrete = concretePattern(rpcContext);
  if (concrete !== undefined && patterns.includes(concrete)) return concrete;
  return patterns[0] ?? concrete ?? "(unknown)";
}

interface Started {
  readonly span: Span;
  readonly ctx: Context;
}

function start(execution: ExecutionContext): Started | undefined {
  fault("server.start");
  if (!microservicesActive()) return undefined;
  if (execution.getType() !== "rpc") return undefined;
  const handler = execution.getHandler() as object | undefined;
  if (typeof handler !== "function") return undefined;
  const rpcContext: unknown = execution.getArgByIndex(1);
  if (alreadyTraced(rpcContext, handler)) return undefined;
  markTraced(rpcContext, handler);

  const isEvent =
    Reflect.getMetadata(PATTERN_HANDLER_METADATA, handler) ===
    PATTERN_HANDLER_EVENT;
  const transport = serverTransport(rpcContext);
  const pattern = declaredPattern(handler, rpcContext);
  const metadata = readMetadata(rpcContext);
  // As for HTTP: the message's trace context when it carries one, otherwise whatever is active in
  // the transport's callback (an upstream client instrumentation's consumer span, or nothing).
  const active = context.active();
  const parent =
    metadata === undefined
      ? active
      : propagation.extract(active, metadata, metadataGetter);
  const attributes: Record<string, string> = {
    [ATTR_MESSAGING_DESTINATION_NAME]: pattern,
    [ATTR_MESSAGING_OPERATION_TYPE]: MESSAGING_OPERATION_PROCESS,
  };
  if (transport !== undefined) attributes[ATTR_MESSAGING_SYSTEM] = transport;
  const className = (execution.getClass() as { name?: unknown } | undefined)
    ?.name;
  const handlerName = (handler as { name?: unknown }).name;
  if (typeof className === "string" && typeof handlerName === "string") {
    attributes[ATTR_CODE_FUNCTION_NAME] = `${className}.${handlerName}`;
  }
  const span = startNestrixSpan(
    trace.getTracer(TRACER_NAME),
    spanName(transport, pattern),
    { kind: isEvent ? SpanKind.CONSUMER : SpanKind.SERVER, attributes },
    parent,
  );
  return { span, ctx: trace.setSpan(parent, span) };
}

function exceptionType(error: unknown): string {
  try {
    if (error !== null && typeof error === "object") {
      const name = (error as { constructor?: { name?: unknown } }).constructor
        ?.name;
      if (typeof name === "string" && name !== "") return name;
    }
  } catch {
    // Fall through.
  }
  return "_OTHER";
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "(unprintable)";
  }
}

/** Records `error` on `span` and sets error status. Never throws. */
export function recordError(span: Span, error: unknown): void {
  try {
    fault("record-error");
    if (error instanceof Error) {
      span.recordException(error);
    } else {
      const message =
        error !== null &&
        typeof error === "object" &&
        typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : safeString(error);
      span.recordException({ name: exceptionType(error), message });
    }
    span.setAttribute(ATTR_ERROR_TYPE, exceptionType(error));
    span.setStatus({ code: SpanStatusCode.ERROR });
  } catch (failure) {
    diagnostics.countFailure("microservices.record-error", failure);
  }
}

function endSpan(span: Span): void {
  try {
    endNestrixSpan(span);
  } catch (failure) {
    diagnostics.countFailure("microservices.end", failure);
  }
}

/**
 * Traces the handler call that `invoke` starts (`next.handle()` or a pre-request hook's `next()`).
 * Calls `invoke` exactly once, and returns its stream with values, completion and the error
 * object passed through unchanged.
 */
export function traceRpc(
  execution: ExecutionContext,
  invoke: () => Observable<unknown>,
): Observable<unknown> {
  let started: Started | undefined;
  try {
    started = start(execution);
  } catch (error) {
    diagnostics.countFailure("microservices.server", error);
    started = undefined;
  }
  if (started === undefined) return invoke();

  const { span, ctx } = started;
  let stream: Observable<unknown>;
  let called = false;
  try {
    stream = context.with(ctx, () => {
      called = true;
      return invoke();
    });
  } catch (error) {
    if (called) {
      // The handler pipeline itself threw: record it and let it reach Nest unchanged.
      recordError(span, error);
      endSpan(span);
      throw error;
    }
    // The context manager failed before calling: run the handler unobserved, once.
    diagnostics.countFailure("microservices.server", error);
    endSpan(span);
    return invoke();
  }

  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    endSpan(span);
  };
  try {
    const observed = stream.pipe(
      tap({
        error: (error: unknown) => {
          recordError(span, error);
          end();
        },
        complete: end,
        finalize: end,
      }),
    );
    // A pre-request hook's `next()` is deferred: guards, pipes, interceptors and the handler run
    // when Nest subscribes, outside this call (P4-S1). Subscribing inside the span's context makes
    // it active there too. (`next.handle()` already binds its scope when called; this is harmless.)
    return new Observable<unknown>((subscriber) => {
      let subscribed = false;
      try {
        return context.with(ctx, () => {
          subscribed = true;
          return observed.subscribe(subscriber);
        });
      } catch (error) {
        if (subscribed) throw error;
        diagnostics.countFailure("microservices.server", error);
        return observed.subscribe(subscriber);
      }
    });
  } catch (error) {
    diagnostics.countFailure("microservices.server", error);
    end();
    return stream;
  }
}

/**
 * Nest pre-request hook for a hybrid app's microservice, whose handlers Nestrix's global
 * interceptor does not reach unless the microservice inherits the app's config. Register it before
 * the microservice initialises:
 *
 * ```ts
 * app
 *   .connectMicroservice(options, { deferInitialization: true })
 *   .registerPreRequestHook(nestrixPreRequestHook);
 * ```
 *
 * It passes straight through when Nestrix is disabled. Safe beside the interceptor: a message is
 * traced once.
 */
export function nestrixPreRequestHook(
  execution: ExecutionContext,
  next: () => Observable<unknown>,
): Observable<unknown> {
  return traceRpc(execution, next);
}

/**
 * The global interceptor's RPC branch: the traced stream for an `rpc` context, or `undefined`
 * (without calling `next.handle()`) for any other context type.
 */
export function interceptRpc(
  execution: ExecutionContext,
  next: { handle(): Observable<unknown> },
): Observable<unknown> | undefined {
  let isRpc = false;
  try {
    isRpc = execution.getType() === "rpc";
  } catch (error) {
    diagnostics.countFailure("microservices.server", error);
  }
  return isRpc ? traceRpc(execution, () => next.handle()) : undefined;
}
