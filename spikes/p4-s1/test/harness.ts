// Shared spike harness: one global provider with an in-memory exporter, the ALS context manager
// and the W3C propagator; prototype probes for the four questions. Throwaway code.
import "reflect-metadata";
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import {
  type Context,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { Observable, tap } from "rxjs";

export const exporter = new InMemorySpanExporter();
let registered = false;
export function setupOtel(): void {
  if (registered) return;
  registered = true;
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
}

export const tracer = () => trace.getTracer("spike-p4-s1");

// ---- Q1 / Q3: what the dispatch hook sees -------------------------------------------------------

export interface DispatchRecord {
  pattern: unknown;
  activeSpanId: string | undefined;
  injected: Record<string, string>;
}
export const dispatched: DispatchRecord[] = [];

export function dispatchHook(packet: {
  pattern: unknown;
  metadata?: Record<string, string>;
}): void {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  dispatched.push({
    pattern: packet.pattern,
    activeSpanId: trace.getActiveSpan()?.spanContext().spanId,
    injected: carrier,
  });
  packet.metadata = { ...carrier, "x-probe": "probe-value" };
}

// ---- Q2: which handlers the module-registered global interceptor sees ---------------------------

export interface Seen {
  via: "interceptor" | "pre-request";
  type: string;
  handler: string;
  metadata: unknown;
  activeSpanId: string | undefined;
}
export const seen: Seen[] = [];

function readMetadata(rpcContext: unknown): unknown {
  const getMetadata = (rpcContext as { getMetadata?: () => unknown })
    ?.getMetadata;
  return typeof getMetadata === "function"
    ? getMetadata.call(rpcContext)
    : "(no getMetadata)";
}

@Injectable()
export class ProbeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    seen.push({
      via: "interceptor",
      type: ctx.getType(),
      handler: `${ctx.getClass().name}.${ctx.getHandler().name}`,
      metadata:
        ctx.getType() === "rpc" ? readMetadata(ctx.getArgByIndex(1)) : null,
      activeSpanId: trace.getActiveSpan()?.spanContext().spanId,
    });
    return next.handle();
  }
}

export function probePreRequestHook(
  ctx: ExecutionContext,
  next: () => Observable<unknown>,
): Observable<unknown> {
  seen.push({
    via: "pre-request",
    type: ctx.getType(),
    handler: `${ctx.getClass().name}.${ctx.getHandler().name}`,
    metadata: readMetadata(ctx.getArgByIndex(1)),
    activeSpanId: trace.getActiveSpan()?.spanContext().spanId,
  });
  return next();
}

/** A prototype server-span interceptor: extract, start, run `next.handle()` inside the context. */
@Injectable()
export class SpanInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== "rpc") return next.handle();
    const md = readMetadata(ctx.getArgByIndex(1));
    const parent = propagation.extract(
      context.active(),
      typeof md === "object" && md !== null ? md : {},
    );
    const span = tracer().startSpan(
      `rpc ${ctx.getHandler().name}`,
      { kind: SpanKind.SERVER },
      parent,
    );
    const stream = context.with(trace.setSpan(parent, span), () =>
      next.handle(),
    );
    return stream.pipe(
      tap({
        error: (e: unknown) => {
          span.recordException(e as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
        },
        finalize: () => span.end(),
      }),
    );
  }
}

// ---- Q3: client wrapper prototype ---------------------------------------------------------------

export interface ClientEvents {
  log: string[];
}

interface ClientLike {
  send(pattern: unknown, data: unknown): Observable<unknown>;
  emit(pattern: unknown, data: unknown): Observable<unknown>;
  setOnDispatchHook(hook: (packet: never) => void): void;
}

/** Wraps `send` (span per subscription) and `emit` (span at call, ended by observing the hot result). */
export function wrapClient(client: ClientLike, events: ClientEvents): void {
  client.setOnDispatchHook(dispatchHook as never);
  const send = client.send;
  const emit = client.emit;
  Object.defineProperty(client, "send", {
    configurable: true,
    writable: true,
    enumerable: false,
    value: function send_(this: ClientLike, pattern: unknown, data: unknown) {
      const source = send.call(this, pattern, data);
      return new Observable<unknown>((subscriber) => {
        const parent = context.active();
        const span = tracer().startSpan(
          `send ${String(pattern)}`,
          { kind: SpanKind.CLIENT },
          parent,
        );
        events.log.push(`send:subscribe:${span.spanContext().spanId}`);
        let done = false;
        const finish = (how: string, s: Span) => {
          if (done) return;
          done = true;
          events.log.push(`send:end:${how}`);
          s.setAttribute("end", how);
          s.end();
        };
        const sub = context.with(trace.setSpan(parent, span), () =>
          source.subscribe({
            next: (v) => {
              events.log.push("send:next");
              subscriber.next(v);
            },
            error: (e) => {
              span.setStatus({ code: SpanStatusCode.ERROR });
              finish("error", span);
              subscriber.error(e);
            },
            complete: () => {
              finish("complete", span);
              subscriber.complete();
            },
          }),
        );
        return () => {
          sub.unsubscribe();
          finish("unsubscribe", span);
        };
      });
    },
  });
  Object.defineProperty(client, "emit", {
    configurable: true,
    writable: true,
    enumerable: false,
    value: function emit_(this: ClientLike, pattern: unknown, data: unknown) {
      const parent: Context = context.active();
      const span = tracer().startSpan(
        `emit ${String(pattern)}`,
        { kind: SpanKind.PRODUCER },
        parent,
      );
      events.log.push(`emit:call:${span.spanContext().spanId}`);
      const result = context.with(trace.setSpan(parent, span), () =>
        emit.call(this, pattern, data),
      );
      events.log.push(
        `emit:connectable:${typeof (result as { connect?: unknown }).connect === "function"}`,
      );
      result.subscribe({
        error: () => {
          events.log.push("emit:end:error");
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
        },
        complete: () => {
          events.log.push("emit:end:complete");
          span.end();
        },
      });
      return result;
    },
  });
}

export function reset(): void {
  exporter.reset();
  dispatched.length = 0;
  seen.length = 0;
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(
  fn: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await wait(10);
  }
}
