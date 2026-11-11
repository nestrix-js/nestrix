// Spike P0-S6: method wrapping through `instrument.instanceDecorator`, without Proxy.
//
// Two strategies are compared:
//   "own"   - wrapped functions are defined as non-enumerable own properties of each instance
//   "proto" - each instance's prototype is swapped to a per-class derived prototype that holds the wrappers
//
// Only `@opentelemetry/api` is imported (AGENTS.md rule 5). Every hook and wrapper body catches
// everything it could throw itself (rule 1); errors thrown by the wrapped method are rethrown unchanged.
// Kept free of decorators and non-erasable syntax so `node` can run the benchmark straight from source.
import "reflect-metadata";
import {
  context,
  INVALID_SPANID,
  INVALID_TRACEID,
  isSpanContextValid,
  type Span,
  SpanStatusCode,
  TraceFlags,
  type Tracer,
  trace,
} from "@opentelemetry/api";

/** Any callable. Methods are called with `.apply(receiver, args)`. */
// biome-ignore lint/suspicious/noExplicitAny: any callable, whatever its receiver and parameters
export type Fn = (this: any, ...args: any[]) => any;

export type Strategy = "own" | "proto";

export interface CopyOptions {
  /** Copy every own reflect-metadata key of the original function to the wrapper. */
  metadata: boolean;
  /** Copy other own properties of the original function (not name/length/prototype). */
  ownProps: boolean;
  /** Copy `name`. */
  name: boolean;
  /** Copy `length`. */
  length: boolean;
}

/**
 * How a native promise returned by the wrapped method is handled.
 *   "derived" - return `p.then(end, endAndRethrow)`: a new promise that settles like `p`
 *   "side"    - attach handlers to `p` and return `p` itself (kept only to show why it is wrong)
 */
export type PromiseMode = "derived" | "side";

export interface ClassInfo {
  ctor: unknown;
  proto: object;
  instance: object;
}

export interface WrapOptions {
  strategy: Strategy;
  copy?: Partial<CopyOptions>;
  /** Returns the tracer to use. Called per invocation, so it can be swapped in tests. */
  tracer?: () => Tracer;
  /** Class-level selection. Evaluated once per prototype and cached. Default: wrap. */
  shouldWrapClass?: (info: ClassInfo) => boolean;
  /** Method-level selection. Default: everything `listMethods` returns. */
  shouldWrapMethod?: (name: string, fn: Fn, proto: object) => boolean;
  promiseMode?: PromiseMode;
  /** Prototypes where the method walk stops (in addition to Object.prototype and built-ins). */
  stopAt?: ReadonlySet<object>;
  /**
   * Fast path: when the active span context is valid and not sampled (no TraceFlags.SAMPLED), call
   * the method directly without starting a span; the trace context already in place is inherited.
   * Under a parent-based sampler (the SDK 3 default) such a child would not be sampled either.
   */
  skipUnderNonRecordingParent?: boolean;
  /**
   * When set, a method span is started only under an active span (a request, a job), never as a new
   * root, unless `isEntryMethod` says the method is an entry point (a scheduled job, a queue processor).
   * Entry methods always start a new root span, linked to the span active at call time, if any.
   */
  childOnly?: boolean;
  isEntryMethod?: (name: string, fn: Fn, proto: object) => boolean;
  /** Called (never allowed to throw) when Nestrix's own code fails. */
  onInternalError?: (where: string, error: unknown) => void;
}

const FULL_COPY: CopyOptions = {
  metadata: true,
  ownProps: true,
  name: true,
  length: true,
};

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
 * Prototype methods from the instance's class up to (excluding) Object.prototype and any built-in
 * prototype (Map, Set, Promise, Error...: their constructor is native code). Extra stop prototypes
 * (such as EventEmitter.prototype, which is JavaScript, not native) can be passed in.
 */
export function listMethods(
  proto: object,
  stopAt: ReadonlySet<object> = new Set(),
): Array<[string, Fn, object]> {
  const seen = new Set<string>();
  const out: Array<[string, Fn, object]> = [];
  for (
    let p: object | null = proto;
    p && p !== Object.prototype && p !== Function.prototype && !stopAt.has(p);
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
        fn instanceof AsyncGeneratorFunction
      )
        continue;
      out.push([name, fn, p]);
    }
  }
  return out;
}

const SKIP_OWN_KEYS = new Set<PropertyKey>([
  "length",
  "name",
  "prototype",
  "arguments",
  "caller",
]);

/** Copies the selected parts of `from` onto `to`. Throws if a copy fails, so nothing half-copied is installed. */
export function copyFunctionShape(from: Fn, to: Fn, copy: CopyOptions): void {
  if (copy.metadata) {
    for (const key of Reflect.getOwnMetadataKeys(from)) {
      Reflect.defineMetadata(key, Reflect.getOwnMetadata(key, from), to);
    }
    if (
      Reflect.getOwnMetadataKeys(to).length !==
      Reflect.getOwnMetadataKeys(from).length
    ) {
      throw new Error("metadata copy incomplete");
    }
  }
  if (copy.ownProps) {
    for (const key of Reflect.ownKeys(from)) {
      if (SKIP_OWN_KEYS.has(key)) continue;
      const d = Object.getOwnPropertyDescriptor(from, key);
      if (d) Object.defineProperty(to, key, d);
    }
  }
  for (const key of ["name", "length"] as const) {
    if (!copy[key]) continue;
    const d = Object.getOwnPropertyDescriptor(from, key);
    if (d) Object.defineProperty(to, key, d);
  }
}

const WRAPPERS = new WeakSet<object>();
const DERIVED_PROTOS = new WeakSet<object>();

export function isWrapper(fn: unknown): boolean {
  return typeof fn === "function" && WRAPPERS.has(fn);
}

function safeReport(opts: WrapOptions, where: string, error: unknown): void {
  try {
    opts.onInternalError?.(where, error);
  } catch {
    // A reporting hook must not be able to fail the host either.
  }
}

function endOk(span: Span, opts: WrapOptions): void {
  try {
    span.end();
  } catch (e) {
    safeReport(opts, "span.end", e);
  }
}

function endError(span: Span, error: unknown, opts: WrapOptions): void {
  try {
    span.setStatus({ code: SpanStatusCode.ERROR });
    const type = (error as { constructor?: { name?: unknown } } | null)
      ?.constructor?.name;
    if (typeof type === "string") span.setAttribute("error.type", type);
  } catch (e) {
    safeReport(opts, "span.setStatus", e);
  }
  endOk(span, opts);
}

const defaultTracer = () => trace.getTracer("nestrix-spike-p0-s6");

/**
 * Builds the wrapper for one method. The wrapper is a concise method, like the original, so it has
 * no `prototype` property and cannot be called with `new`.
 */
export function makeWrapper(
  original: Fn,
  spanName: string,
  opts: WrapOptions,
  isEntry = false,
  /** Where the method lives (the class prototype) and its name, for the call-time lookup. */
  home?: { proto: object; name: string },
): Fn {
  const getTracer = opts.tracer ?? defaultTracer;
  const promiseMode = opts.promiseMode ?? "derived";
  const fastPath = opts.skipUnderNonRecordingParent === true && !isEntry;
  const childOnly = opts.childOnly === true && !isEntry;

  /**
   * The method to call: what the prototype holds now, so a patch made after decoration
   * (`vi.spyOn(Svc.prototype, "m")`) still applies. Falls back to the copy captured at decoration
   * when the lookup finds a wrapper, a non-function, or throws.
   */
  function target(): Fn {
    if (!home) return original;
    try {
      const f = (home.proto as Record<string, unknown>)[home.name];
      if (typeof f === "function" && !WRAPPERS.has(f)) return f as Fn;
    } catch (e) {
      safeReport(opts, "lookup", e);
    }
    return original;
  }

  function invoke(self: unknown, args: unknown[]): unknown {
    const fn = target();
    let span: Span | undefined;
    let ctx: ReturnType<typeof context.active> | undefined;
    if (fastPath || childOnly) {
      let skip = false;
      try {
        const active = context.active();
        if (childOnly && trace.getSpan(active) === undefined) skip = true;
        else if (fastPath) {
          // Skip only for an unsampled trace: a valid parent context without the SAMPLED flag.
          // `isRecording()` is not used: in SDK 3 it is false once a sampled parent has ended, which
          // would drop spans for work that outlives the request (fire-and-forget calls).
          const sc = trace.getSpanContext(active);
          // Validity is checked against the all-zero ids only (what INVALID_SPAN_CONTEXT carries);
          // isSpanContextValid's hex regexes cost about 100 ns per call here. Propagators already
          // reject malformed ids on extraction.
          skip =
            sc !== undefined &&
            (sc.traceFlags & TraceFlags.SAMPLED) === 0 &&
            sc.spanId !== INVALID_SPANID &&
            sc.traceId !== INVALID_TRACEID;
        }
      } catch (e) {
        safeReport(opts, "fastPath", e);
      }
      if (skip) return fn.apply(self, args);
    }
    try {
      if (isEntry) {
        // Entry points (scheduled jobs, queue processors) start a trace of their own, linked to
        // whatever span was active when they were set up or triggered.
        const sc = trace.getSpanContext(context.active());
        span = getTracer().startSpan(spanName, {
          root: true,
          links: sc && isSpanContextValid(sc) ? [{ context: sc }] : undefined,
        });
      } else {
        span = getTracer().startSpan(spanName);
      }
      ctx = trace.setSpan(context.active(), span);
    } catch (e) {
      safeReport(opts, "startSpan", e);
      if (span) endOk(span, opts);
      span = undefined;
    }
    if (!span || !ctx) return fn.apply(self, args);

    // 0: not entered, 1: returned, 2: threw. The method's own throw is captured and rethrown below,
    // so a failure of the context manager can be told apart from a failure of the method.
    let state = 0;
    let result: unknown;
    let thrown: unknown;
    try {
      context.with(ctx, () => {
        try {
          result = fn.apply(self, args);
          state = 1;
        } catch (e) {
          thrown = e;
          state = 2;
        }
      });
    } catch (e) {
      safeReport(opts, "context.with", e);
    }
    if (state === 0) {
      // The context manager failed before running the method: run it untraced.
      endOk(span, opts);
      return fn.apply(self, args);
    }
    if (state === 2) {
      endError(span, thrown, opts);
      throw thrown;
    }
    // Only plain native promises. A Promise subclass may be lazy (its executor runs on the first
    // then()) or carry its own API, so calling then() on it would change behaviour and its type; it
    // is treated like any other thenable below. An Observable is returned as is too: the span ends
    // here, before anyone subscribes, and errors emitted later are not seen.
    if (
      result !== null &&
      typeof result === "object" &&
      Object.getPrototypeOf(result) === Promise.prototype
    ) {
      const s = span;
      const p = result as Promise<unknown>;
      try {
        if (promiseMode === "side") {
          p.then(
            () => endOk(s, opts),
            (e: unknown) => endError(s, e, opts),
          );
          return p;
        }
        return p.then(
          (v: unknown) => {
            endOk(s, opts);
            return v;
          },
          (e: unknown) => {
            endError(s, e, opts);
            throw e;
          },
        );
      } catch (e) {
        safeReport(opts, "promise.then", e);
        endOk(s, opts);
        return result;
      }
    }
    // Synchronous result, a Promise subclass, an Observable, or a non-native thenable (a query
    // builder, a Mongoose query): returned as is, span ended now.
    endOk(span, opts);
    return result;
  }

  const holder = {
    wrapped(this: unknown, ...args: unknown[]): unknown {
      return invoke(this, args);
    },
  };
  const wrapped = holder.wrapped;
  WRAPPERS.add(wrapped);
  return wrapped;
}

interface Plan {
  proto: object;
  methods: Array<[string, Fn]>;
  derived?: object;
}

function className(info: ClassInfo): string {
  const n = (info.ctor as { name?: unknown } | undefined)?.name;
  return typeof n === "string" && n ? n : "anonymous";
}

function buildPlan(
  instance: object,
  proto: object,
  opts: WrapOptions,
): Plan | null {
  const info: ClassInfo = {
    ctor:
      Object.getOwnPropertyDescriptor(proto, "constructor")?.value ??
      (proto as { constructor?: unknown }).constructor,
    proto,
    instance,
  };
  if (opts.shouldWrapClass && !opts.shouldWrapClass(info)) return null;
  const copy = { ...FULL_COPY, ...opts.copy };
  const cls = className(info);
  const methods: Array<[string, Fn]> = [];
  for (const [name, fn] of listMethods(proto, opts.stopAt)) {
    if (isWrapper(fn)) continue;
    if (opts.shouldWrapMethod && !opts.shouldWrapMethod(name, fn, proto))
      continue;
    try {
      const entry = opts.isEntryMethod?.(name, fn, proto) === true;
      const w = makeWrapper(fn, `${cls}.${name}`, opts, entry, { proto, name });
      copyFunctionShape(fn, w, copy);
      methods.push([name, w]);
    } catch (e) {
      // Leave this method unwrapped rather than install a wrapper that lost metadata.
      safeReport(opts, `wrap ${cls}.${name}`, e);
    }
  }
  if (methods.length === 0) return null;
  const plan: Plan = { proto, methods };
  if (opts.strategy === "proto") {
    const derived = Object.create(proto) as object;
    for (const [name, w] of methods) {
      Object.defineProperty(derived, name, {
        value: w,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    DERIVED_PROTOS.add(derived);
    plan.derived = derived;
  }
  return plan;
}

/** Creates an `instrument.instanceDecorator`. Returns the same instance it was given, always. */
export function createInstanceDecorator(
  opts: WrapOptions,
): (instance: unknown) => unknown {
  const plans = new WeakMap<object, Plan | null>();
  return function nestrixInstanceDecorator(instance: unknown): unknown {
    try {
      // Functions (plain middleware, factory results that are functions) and primitives pass untouched.
      if (instance === null || typeof instance !== "object") return instance;
      const proto = Object.getPrototypeOf(instance) as object | null;
      // Plain objects (value providers, factory results like `{ ... }`) have no class to wrap.
      if (proto === null || proto === Object.prototype) return instance;
      if (DERIVED_PROTOS.has(proto)) return instance; // already decorated ("proto" strategy)
      let plan = plans.get(proto);
      if (plan === undefined) {
        plan = buildPlan(instance, proto, opts);
        plans.set(proto, plan);
      }
      if (plan === null) return instance;
      if (!Object.isExtensible(instance)) return instance;
      if (opts.strategy === "proto") {
        Object.setPrototypeOf(instance, plan.derived as object);
      } else {
        for (const [name, w] of plan.methods) {
          if (Object.hasOwn(instance, name)) continue; // a class field or an earlier decoration
          Object.defineProperty(instance, name, {
            value: w,
            writable: true,
            enumerable: false,
            configurable: true,
          });
        }
      }
      return instance;
    } catch (e) {
      safeReport(opts, "instanceDecorator", e);
      return instance;
    }
  };
}
