/**
 * Client side of microservice tracing (backlog P4-01, spike P4-S1 Q3 and Q4, D-38):
 * - context injection through `ClientProxy.setOnDispatchHook`, which runs once per outgoing
 *   packet, in the caller's async context (for `send`, the subscriber's);
 * - CLIENT spans for `send` and PRODUCER spans for `emit`, by wrapping those two methods on the
 *   client instance (own non-enumerable properties carrying the original's `name` and `length`;
 *   no `Proxy`; idempotent).
 *
 * Timing, from the spike: `send` returns a cold Observable that dispatches once per subscription,
 * so its span starts at subscription and ends at the first of completion, error or unsubscription
 * (`firstValueFrom` unsubscribes right after a single reply, before completion). `emit` is hot:
 * it dispatches when called, subscribed or not, and returns an rxjs connectable. Its span starts at
 * the call and ends when that connectable completes or errors, observed by a subscription of
 * Nestrix's own, which neither dispatches again nor changes what an unobserved failure does.
 *
 * Rules shared with outbound HTTP (architecture §4.2): no span and no injection under the
 * suppress-tracing key or without an active, valid parent span; injection adds only what the
 * packet does not carry already. Every Nestrix body is guarded; `send` and `emit` themselves are
 * called exactly once, outside the guard, and their results and errors reach the caller unchanged.
 */
import {
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { ATTR_ERROR_TYPE } from "@opentelemetry/semantic-conventions";
import { Observable, type Subscriber, type Subscription } from "rxjs";
import { diagnostics } from "../diagnostics.js";
import { parentContext } from "../outbound/rules.js";
import { endNestrixSpan, startNestrixSpan } from "../trace-limit.js";
import { recordError } from "./server.js";
import {
  ATTR_MESSAGING_DESTINATION_NAME,
  ATTR_MESSAGING_OPERATION_TYPE,
  ATTR_MESSAGING_SYSTEM,
  ATTR_NESTRIX_MESSAGING_CANCELLED,
  clientTransport,
  fault,
  MESSAGING_OPERATION_SEND,
  microservicesActive,
  normalizePattern,
  spanName,
  TRACER_NAME,
} from "./shared.js";

type Method = (this: unknown, pattern: unknown, data: unknown) => unknown;

interface ClientLike {
  send: Method;
  emit: Method;
  setOnDispatchHook?: (hook: (packet: PacketLike) => void) => void;
}

interface PacketLike {
  pattern: unknown;
  metadata?: unknown;
}

interface ClientState {
  readonly transport: string | undefined;
  /** Set the first time Nestrix's dispatch hook runs for this client. */
  hookRan: boolean;
  /** Whether Nestrix set its dispatch hook (Nest 12.0.4+). */
  readonly hookSet: boolean;
}

const instrumented = new WeakMap<object, ClientState>();

/** A `ClientProxy` from any copy of `@nestjs/microservices`, recognised by shape. */
export function looksLikeClient(value: unknown): value is ClientLike {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.send === "function" &&
    typeof v.emit === "function" &&
    typeof v.connect === "function" &&
    typeof v.close === "function" &&
    typeof v.setOnDispatchHook === "function"
  );
}

// ---------------------------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------------------------

const metadataSetter = {
  set(carrier: Record<string, string>, key: string, value: string) {
    carrier[key] = value;
  },
};

/**
 * Adds the active trace context to `packet.metadata`, keeping every entry already there; adds
 * nothing when the packet already carries a `traceparent`. A value with a line break is never
 * added (NATS fails the call on one).
 */
export function injectIntoPacket(packet: PacketLike): void {
  if (!microservicesActive()) return;
  const ctx = parentContext(context.active());
  if (ctx === undefined) return;
  const existing: unknown = packet.metadata;
  const base: Record<string, unknown> =
    existing !== null && typeof existing === "object"
      ? (existing as Record<string, unknown>)
      : {};
  if (base.traceparent !== undefined) return;
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier, metadataSetter);
  let merged: Record<string, unknown> | undefined;
  for (const key of Object.keys(carrier)) {
    const value = carrier[key];
    if (typeof value !== "string" || /[\r\n]/.test(value)) continue;
    if (base[key] !== undefined) continue;
    merged ??= { ...base };
    merged[key] = value;
  }
  if (merged !== undefined) packet.metadata = merged;
}

function dispatchHookFor(state: ClientState): (packet: PacketLike) => void {
  return (packet) => {
    try {
      state.hookRan = true;
      fault("client.dispatch");
      injectIntoPacket(packet);
    } catch (error) {
      diagnostics.countFailure("microservices.dispatch", error);
    }
  };
}

/**
 * The dispatch hook is a single slot without a public getter (`onDispatchHook` is protected), so
 * another tool replacing Nestrix's hook cannot be seen directly. It shows indirectly: a call that
 * completed without Nestrix's hook ever having run for that client.
 */
function checkHookRan(state: ClientState): void {
  try {
    if (state.hookSet && !state.hookRan) {
      diagnostics.logOnce(
        "microservices.foreign-dispatch-hook",
        "A microservice client completed a call without Nestrix's dispatch hook running: another tool replaced it with setOnDispatchHook (a single slot). Trace context is not propagated from that client.",
      );
    }
  } catch {
    // Diagnostics never throw.
  }
}

// ---------------------------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------------------------

function startClientSpan(
  state: ClientState,
  pattern: unknown,
  kind: SpanKind,
): { span: Span; ctx: ReturnType<typeof context.active> } | undefined {
  if (!microservicesActive()) return undefined;
  const parent = parentContext(context.active());
  if (parent === undefined) return undefined;
  const destination = normalizePattern(pattern);
  const attributes: Record<string, string> = {
    [ATTR_MESSAGING_DESTINATION_NAME]: destination,
    [ATTR_MESSAGING_OPERATION_TYPE]: MESSAGING_OPERATION_SEND,
  };
  if (state.transport !== undefined)
    attributes[ATTR_MESSAGING_SYSTEM] = state.transport;
  const span = startNestrixSpan(
    trace.getTracer(TRACER_NAME),
    spanName(state.transport, destination),
    { kind, attributes },
    parent,
  );
  return { span, ctx: trace.setSpan(parent, span) };
}

function endSpan(span: Span): void {
  try {
    endNestrixSpan(span);
  } catch (error) {
    diagnostics.countFailure("microservices.end", error);
  }
}

function copyShape(from: Method, to: Method): void {
  for (const key of ["name", "length"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(from, key);
    if (descriptor) Object.defineProperty(to, key, descriptor);
  }
}

function isObservableLike(value: unknown): value is Observable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { subscribe?: unknown }).subscribe === "function"
  );
}

/** One subscription to `send`'s cold Observable, traced. */
function subscribeTraced(
  state: ClientState,
  pattern: unknown,
  source: Observable<unknown>,
  subscriber: Subscriber<unknown>,
): () => void {
  let started: ReturnType<typeof startClientSpan>;
  try {
    fault("client.send");
    started = startClientSpan(state, pattern, SpanKind.CLIENT);
  } catch (error) {
    diagnostics.countFailure("microservices.client", error);
    started = undefined;
  }
  if (started === undefined) {
    const plain = source.subscribe(subscriber);
    return () => plain.unsubscribe();
  }

  const { span, ctx } = started;
  let settled = false;
  let values = 0;
  const finish = (error: unknown, failed: boolean, cancelled: boolean) => {
    if (settled) return;
    settled = true;
    try {
      if (failed) recordError(span, error);
      else if (cancelled)
        span.setAttribute(ATTR_NESTRIX_MESSAGING_CANCELLED, true);
      else checkHookRan(state);
    } catch (failure) {
      diagnostics.countFailure("microservices.client", failure);
    }
    endSpan(span);
  };
  const observer = {
    next: (value: unknown) => {
      values++;
      subscriber.next(value);
    },
    error: (error: unknown) => {
      finish(error, true, false);
      subscriber.error(error);
    },
    complete: () => {
      finish(undefined, false, false);
      subscriber.complete();
    },
  };

  let inner: Subscription | undefined;
  let called = false;
  try {
    inner = context.with(ctx, () => {
      called = true;
      return source.subscribe(observer);
    });
  } catch (error) {
    if (called) {
      finish(error, true, false);
      throw error;
    }
    diagnostics.countFailure("microservices.client", error);
    endSpan(span);
    settled = true;
    inner = source.subscribe(subscriber);
  }
  const subscription = inner;
  return () => {
    subscription?.unsubscribe();
    // After a value, unsubscribing is how `firstValueFrom` and `take(1)` end a call normally.
    finish(undefined, false, values === 0);
  };
}

function wrapSend(state: ClientState, original: Method): Method {
  const wrapper = {
    send(this: unknown, pattern: unknown, data: unknown): unknown {
      const source = Reflect.apply(original, this, [pattern, data]);
      try {
        if (!microservicesActive() || !isObservableLike(source)) return source;
        return new Observable<unknown>((subscriber) =>
          subscribeTraced(state, pattern, source, subscriber),
        );
      } catch (error) {
        diagnostics.countFailure("microservices.client", error);
        return source;
      }
    },
  }.send as Method;
  copyShape(original, wrapper);
  return wrapper;
}

function isConnectable(value: unknown): value is Observable<unknown> {
  return (
    isObservableLike(value) &&
    typeof (value as { connect?: unknown }).connect === "function"
  );
}

function observeEmit(state: ClientState, span: Span, result: unknown): void {
  try {
    fault("client.emit-result");
    if (!isConnectable(result)) {
      // Not the built-in hot connectable (a custom transport): subscribing could dispatch the
      // event again, so the span covers the call only.
      endSpan(span);
      return;
    }
    let settled = false;
    result.subscribe({
      error: (error: unknown) => {
        if (settled) return;
        settled = true;
        recordError(span, error);
        endSpan(span);
      },
      complete: () => {
        if (settled) return;
        settled = true;
        checkHookRan(state);
        endSpan(span);
      },
    });
  } catch (error) {
    diagnostics.countFailure("microservices.client", error);
    endSpan(span);
  }
}

function recordInvalidMessage(span: Span): void {
  try {
    span.recordException({
      name: "InvalidMessageException",
      message: "The pattern or the data of the message is null or undefined",
    });
    span.setAttribute(ATTR_ERROR_TYPE, "InvalidMessageException");
    span.setStatus({ code: SpanStatusCode.ERROR });
  } catch (error) {
    diagnostics.countFailure("microservices.client", error);
  }
}

function wrapEmit(state: ClientState, original: Method): Method {
  const wrapper = {
    emit(this: unknown, pattern: unknown, data: unknown): unknown {
      let started: ReturnType<typeof startClientSpan>;
      try {
        fault("client.emit");
        started = startClientSpan(state, pattern, SpanKind.PRODUCER);
      } catch (error) {
        diagnostics.countFailure("microservices.client", error);
        started = undefined;
      }
      if (started === undefined)
        return Reflect.apply(original, this, [pattern, data]);

      const { span, ctx } = started;
      if (
        pattern === null ||
        pattern === undefined ||
        data === null ||
        data === undefined
      ) {
        // Nest returns a `throwError` observable and sends nothing (`InvalidMessageException`).
        recordInvalidMessage(span);
        endSpan(span);
        return Reflect.apply(original, this, [pattern, data]);
      }
      let result: unknown;
      let called = false;
      try {
        result = context.with(ctx, () => {
          called = true;
          return Reflect.apply(original, this, [pattern, data]);
        });
      } catch (error) {
        if (called) {
          recordError(span, error);
          endSpan(span);
          throw error;
        }
        diagnostics.countFailure("microservices.client", error);
        endSpan(span);
        return Reflect.apply(original, this, [pattern, data]);
      }
      observeEmit(state, span, result);
      return result;
    },
  }.emit as Method;
  copyShape(original, wrapper);
  return wrapper;
}

function install(client: ClientLike, state: ClientState): void {
  const send = client.send;
  const emit = client.emit;
  // gRPC clients do not support `send`/`emit` (they throw); their calls go through `getService`.
  if (state.transport === "grpc") return;
  Object.defineProperty(client, "send", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: wrapSend(state, send),
  });
  Object.defineProperty(client, "emit", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: wrapEmit(state, emit),
  });
}

function clientName(client: object): string {
  try {
    const name = (client as { constructor?: { name?: unknown } }).constructor
      ?.name;
    if (typeof name === "string" && name !== "") return name;
  } catch {
    // Fall through.
  }
  return "a client";
}

/**
 * Instruments a microservice client created outside dependency injection
 * (`ClientProxyFactory.create(...)`, or `new ClientTCP(...)`): propagates the active trace context
 * in each packet's metadata, and gives `send` a CLIENT span and `emit` a PRODUCER span. Clients
 * registered through `ClientsModule` are instrumented automatically.
 *
 * Returns the same client. Calling it twice is harmless; it never throws, and anything that is not
 * a client is returned untouched. While Nestrix is disabled or shut down, the client behaves as if
 * it were never instrumented. It takes the client's dispatch hook slot (`setOnDispatchHook`); a
 * hook set later by anything else replaces Nestrix's, which Nestrix logs once when it notices.
 */
export function instrumentClient<T>(client: T): T {
  try {
    fault("client.instrument");
    if (!looksLikeClient(client) || instrumented.has(client)) return client;
    let hookSet = false;
    const transport = clientTransport(client);
    const state: ClientState = {
      transport,
      hookRan: false,
      get hookSet() {
        return hookSet;
      },
    };
    instrumented.set(client, state);
    const existing = (client as { onDispatchHook?: unknown }).onDispatchHook;
    if (typeof existing === "function") {
      // The slot is single; a host hook set before us is kept, and this client gets spans only.
      diagnostics.logOnce(
        "microservices.host-dispatch-hook",
        `a dispatch hook is already set on ${clientName(client)}; Nestrix keeps it and does not inject trace context for this client`,
      );
    } else {
      client.setOnDispatchHook?.(dispatchHookFor(state));
      hookSet = true;
    }
    install(client, state);
  } catch (error) {
    diagnostics.countFailure("microservices.instrument", error);
  }
  return client;
}
