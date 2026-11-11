// Level 2 method wrappers (architecture §4.3), ported from the P0-S6 reference wrapper
// (`spikes/p0-s6/src/wrap.ts`, strategy "own").
//
// Imports `@opentelemetry/api` only (AGENTS.md rule 5). Everything that is Nestrix's own work is
// guarded (rule 1): the method runs exactly once, and its result or error reaches the caller
// unchanged. A wrapper belongs to a per-class plan; while the plan is off it calls straight through.
import "reflect-metadata";
import { EventEmitter } from "node:events";
import {
  type Attributes,
  type Context,
  context,
  type Exception,
  INVALID_SPANID,
  INVALID_TRACEID,
  isSpanContextValid,
  type Span,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { diagnostics } from "../diagnostics.js";
import type { EntryKind } from "./classify.js";
import type { MethodClassKind } from "./sink.js";
import { getMethodCallSink, type MethodCallSink } from "./sink.js";

/** Any callable, called with `Reflect.apply(fn, receiver, args)`. */
// biome-ignore lint/suspicious/noExplicitAny: any callable, whatever its receiver and parameters
export type Fn = (this: any, ...args: any[]) => any;

const TRACER_NAME = "@nestrix/nestjs";

/** The class-level switch every wrapper of a class reads at call time. */
export interface PlanSwitch {
  readonly className: string;
  readonly kind: MethodClassKind;
  /** Read on every call. `false`: the wrapper calls straight through and reports nothing. */
  on: boolean;
}

/** Names never wrapped: lifecycle hooks and conversions. */
export const SKIPPED_METHOD_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "onModuleInit",
  "onApplicationBootstrap",
  "onModuleDestroy",
  "beforeApplicationShutdown",
  "onApplicationShutdown",
  "toString",
  "toJSON",
  "valueOf",
]);

/**
 * Prototypes where the method walk stops besides built-ins: `EventEmitter.prototype` is JavaScript,
 * not native code, so without this `on`, `emit` and `listenerCount` of an emitter subclass would be
 * wrapped (P0-S6 Q4).
 */
const STOP_AT: ReadonlySet<object> = new Set([EventEmitter.prototype]);

const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
const AsyncGeneratorFunction = Object.getPrototypeOf(
  async function* () {},
).constructor;

function isNativeFunction(fn: unknown): boolean {
  try {
    return (
      typeof fn === "function" &&
      /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(fn))
    );
  } catch {
    return true;
  }
}

/**
 * Prototype methods from `proto` up to (excluding) `Object.prototype`, any built-in prototype (its
 * constructor is native code) and `STOP_AT`. Accessors, generators, async generators and the names in
 * `SKIPPED_METHOD_NAMES` are left out. Reads descriptors only, so no getter runs.
 */
export function listMethods(proto: object): Array<[string, Fn]> {
  const seen = new Set<string>();
  const out: Array<[string, Fn]> = [];
  for (
    let p: object | null = proto;
    p && p !== Object.prototype && p !== Function.prototype && !STOP_AT.has(p);
    p = Object.getPrototypeOf(p)
  ) {
    const ctor = Object.getOwnPropertyDescriptor(p, "constructor")?.value;
    if (isNativeFunction(ctor)) break;
    for (const name of Object.getOwnPropertyNames(p)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (SKIPPED_METHOD_NAMES.has(name)) continue;
      const d = Object.getOwnPropertyDescriptor(p, name);
      if (!d || d.get || d.set || typeof d.value !== "function") continue;
      const fn = d.value as Fn;
      if (
        fn instanceof GeneratorFunction ||
        fn instanceof AsyncGeneratorFunction ||
        WRAPPERS.has(fn)
      )
        continue;
      out.push([name, fn]);
    }
  }
  return out;
}

const SKIP_OWN_KEYS: ReadonlySet<PropertyKey> = new Set([
  "length",
  "name",
  "prototype",
  "arguments",
  "caller",
]);

/**
 * Copies every own reflect-metadata key, every other own property, then `name` and `length` from
 * `from` to `to` (D-34). Throws if the metadata copy is incomplete, so a wrapper that lost metadata
 * (a method guard that would silently stop applying) is never installed.
 */
export function copyFunctionShape(from: Fn, to: Fn): void {
  for (const key of Reflect.getOwnMetadataKeys(from)) {
    Reflect.defineMetadata(key, Reflect.getOwnMetadata(key, from), to);
  }
  if (
    Reflect.getOwnMetadataKeys(to).length !==
    Reflect.getOwnMetadataKeys(from).length
  ) {
    throw new Error("metadata copy incomplete");
  }
  for (const key of Reflect.ownKeys(from)) {
    if (SKIP_OWN_KEYS.has(key)) continue;
    const d = Object.getOwnPropertyDescriptor(from, key);
    if (d) Object.defineProperty(to, key, d);
  }
  for (const key of ["name", "length"] as const) {
    const d = Object.getOwnPropertyDescriptor(from, key);
    if (d) Object.defineProperty(to, key, d);
  }
}

const WRAPPERS = new WeakSet<object>();

/** Whether `fn` is a level 2 wrapper. */
export function isWrapper(fn: unknown): boolean {
  return typeof fn === "function" && WRAPPERS.has(fn);
}

// Captured at load so a later patch of `Promise.prototype.then`, or an own `then` on a promise,
// cannot reach Nestrix's own code (as in `span.ts`).
const promiseThen = Promise.prototype.then;

function isNativePromise(value: unknown): value is Promise<unknown> {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Promise.prototype
    );
  } catch {
    return false;
  }
}

function endSpan(span: Span): void {
  try {
    span.end();
  } catch (error) {
    diagnostics.countFailure("methods.span-end", error);
  }
}

function failSpan(span: Span, error: unknown): void {
  try {
    span.recordException(
      (typeof error === "string" ||
      (typeof error === "object" && error !== null)
        ? error
        : String(error)) as Exception,
    );
    span.setStatus({ code: SpanStatusCode.ERROR });
  } catch (e) {
    diagnostics.countFailure("methods.span-status", e);
  }
  endSpan(span);
}

function report(
  sink: MethodCallSink | undefined,
  plan: PlanSwitch,
  method: string,
  t0: number,
  error: boolean,
): void {
  if (!sink) return;
  try {
    sink.record(
      plan.className,
      plan.kind,
      method,
      performance.now() - t0,
      error,
    );
  } catch (e) {
    diagnostics.countFailure("methods.sink", e);
  }
}

/**
 * Whether to skip the span: the active context carries a valid span context without the SAMPLED
 * flag (an unsampled trace). `isRecording()` is not the test: in SDK 3 it is false once a sampled
 * parent ends, which would drop spans for work that outlives the request (architecture §4.3).
 * Validity is checked against the all-zero ids only (what `INVALID_SPAN_CONTEXT` carries).
 */
function underUnsampledParent(active: Context): boolean {
  const sc = trace.getSpanContext(active);
  return (
    sc !== undefined &&
    (sc.traceFlags & TraceFlags.SAMPLED) === 0 &&
    sc.spanId !== INVALID_SPANID &&
    sc.traceId !== INVALID_TRACEID
  );
}

/**
 * Builds the wrapper for one method of a class. The wrapper is a concise method, like the
 * original, so it has no `prototype` and is not constructible. It calls the method the prototype
 * holds at call time (so a `vi.spyOn(Class.prototype, m)` after decoration applies), falling back to
 * `original`.
 */
export function makeWrapper(
  plan: PlanSwitch,
  proto: object,
  method: string,
  original: Fn,
  entry: EntryKind | undefined,
): Fn {
  const spanName = `${plan.className}.${method}`;
  const attributes: Attributes = {
    "code.function.name": spanName,
    "nestrix.class": plan.className,
    "nestrix.method": method,
    "nestrix.component": plan.kind,
  };
  if (entry) attributes["nestrix.entry"] = entry;
  const scheduled = entry === "scheduled";

  function target(): Fn {
    try {
      const f = (proto as Record<string, unknown>)[method];
      if (typeof f === "function" && !WRAPPERS.has(f)) return f as Fn;
    } catch (error) {
      diagnostics.countFailure("methods.lookup", error);
    }
    return original;
  }

  /** No span: calls the method, reporting to the sink when one is installed. */
  function untraced(
    fn: Fn,
    self: unknown,
    args: unknown[],
    sink: MethodCallSink | undefined,
    t0: number,
  ): unknown {
    if (!sink) return Reflect.apply(fn, self, args);
    let result: unknown;
    try {
      result = Reflect.apply(fn, self, args);
    } catch (error) {
      report(sink, plan, method, t0, true);
      throw error;
    }
    if (isNativePromise(result)) {
      try {
        return Reflect.apply(promiseThen, result, [
          (value: unknown) => {
            report(sink, plan, method, t0, false);
            return value;
          },
          (error: unknown) => {
            report(sink, plan, method, t0, true);
            throw error;
          },
        ]);
      } catch (error) {
        diagnostics.countFailure("methods.promise", error);
        return result;
      }
    }
    report(sink, plan, method, t0, false);
    return result;
  }

  function invoke(self: unknown, args: unknown[]): unknown {
    const fn = target();
    if (!plan.on) return Reflect.apply(fn, self, args);

    let sink: MethodCallSink | undefined;
    let t0 = 0;
    let span: Span | undefined;
    let ctx: Context | undefined;
    try {
      sink = getMethodCallSink();
      if (sink) t0 = performance.now();
      const active = context.active();
      if (scheduled) {
        // A scheduled tick always starts its own trace, linked to whatever was active (D-62): a
        // timer callback can inherit the context of whatever registered it.
        const sc = trace.getSpanContext(active);
        span = trace.getTracer(TRACER_NAME).startSpan(spanName, {
          kind: SpanKind.INTERNAL,
          attributes,
          root: true,
          links: sc && isSpanContextValid(sc) ? [{ context: sc }] : undefined,
        });
      } else if (!underUnsampledParent(active)) {
        // Ordinary methods and BullMQ `process`: a child of the active span, or a new root when
        // there is none (D-62 for `process`).
        span = trace
          .getTracer(TRACER_NAME)
          .startSpan(spanName, { kind: SpanKind.INTERNAL, attributes }, active);
      }
      if (span) ctx = trace.setSpan(active, span);
    } catch (error) {
      diagnostics.countFailure("methods.start-span", error);
      if (span) endSpan(span);
      span = undefined;
      ctx = undefined;
    }
    if (!span || !ctx) return untraced(fn, self, args, sink, t0);

    // 0: not entered, 1: returned, 2: threw. The method's own throw is captured and rethrown below,
    // so a failure of the context manager can be told apart from a failure of the method.
    let state = 0;
    let result: unknown;
    let thrown: unknown;
    try {
      context.with(ctx, () => {
        try {
          result = Reflect.apply(fn, self, args);
          state = 1;
        } catch (error) {
          thrown = error;
          state = 2;
        }
      });
    } catch (error) {
      diagnostics.countFailure("methods.context", error);
    }
    if (state === 0) {
      // The context manager failed before running the method: run it once, untraced.
      endSpan(span);
      return untraced(fn, self, args, sink, t0);
    }
    if (state === 2) {
      failSpan(span, thrown);
      report(sink, plan, method, t0, true);
      throw thrown;
    }
    // Only plain native promises are followed. A Promise subclass may be lazy or carry its own API;
    // other thenables and Observables are returned untouched and the span ends now (§4.3).
    if (isNativePromise(result)) {
      const s = span;
      try {
        return Reflect.apply(promiseThen, result, [
          (value: unknown) => {
            endSpan(s);
            report(sink, plan, method, t0, false);
            return value;
          },
          (error: unknown) => {
            failSpan(s, error);
            report(sink, plan, method, t0, true);
            throw error;
          },
        ]);
      } catch (error) {
        diagnostics.countFailure("methods.promise", error);
        endSpan(s);
        report(sink, plan, method, t0, false);
        return result;
      }
    }
    endSpan(span);
    report(sink, plan, method, t0, false);
    return result;
  }

  const wrapped = {
    wrapped(this: unknown, ...args: unknown[]): unknown {
      return invoke(this, args);
    },
  }.wrapped;
  WRAPPERS.add(wrapped);
  return wrapped;
}
