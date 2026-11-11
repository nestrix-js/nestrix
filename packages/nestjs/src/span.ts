// Custom spans: the `Span` method decorator and `withSpan`.
//
// Imports `@opentelemetry/api` only (AGENTS.md rule 5). Everything that is Nestrix's own bookkeeping
// is guarded (rule 1); the user's function runs exactly once and its result or error reaches the
// caller untouched (architecture §4.2, "Decide inside the guard, then call the original once").
import "reflect-metadata";
import {
  type Span as ApiSpan,
  type Exception,
  type SpanOptions,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

const TRACER_NAME = "@nestrix-js/nestjs";

function end(span: ApiSpan): void {
  try {
    span.end();
  } catch {
    // Nestrix's own bookkeeping never fails the host.
  }
}

function fail(span: ApiSpan, error: unknown): void {
  try {
    span.recordException(
      (typeof error === "string" ||
      (typeof error === "object" && error !== null)
        ? error
        : String(error)) as Exception,
    );
    span.setStatus({ code: SpanStatusCode.ERROR });
  } catch {
    // see end()
  }
  end(span);
}

function isNativePromise(value: unknown): value is Promise<unknown> {
  try {
    return (
      typeof value === "object" &&
      value !== null &&
      Object.getPrototypeOf(value) === Promise.prototype
    );
  } catch {
    return false;
  }
}

// Captured at load so a later patch of `Promise.prototype.then`, or an own `then` property on a
// promise, cannot reach Nestrix's own code.
const promiseThen = Promise.prototype.then;

type Outcome<T> =
  | { kind: "return"; value: T }
  | { kind: "throw"; error: unknown };

/**
 * Runs `fn` inside an active span. The span ends when `fn` returns or, when it returns a plain
 * native promise, when that promise settles (the caller then gets a derived promise that settles
 * the same way). A throw or rejection is recorded, sets error status and is rethrown unchanged.
 * Other thenables and Observables are returned untouched and their span ends when `fn` returns.
 * If the tracer itself fails, `fn` still runs once, with a non-recording span.
 */
export function withSpan<T>(
  name: string,
  fn: (span: ApiSpan) => T,
  options?: SpanOptions,
): T {
  let outcome: Outcome<T> | undefined;
  let started = false;
  try {
    const tracer = trace.getTracer(TRACER_NAME);
    const returned = tracer.startActiveSpan(name, options ?? {}, (span) => {
      started = true;
      let result: T;
      try {
        result = fn(span);
      } catch (error) {
        outcome = { kind: "throw", error };
        fail(span, error);
        throw error;
      }
      outcome = { kind: "return", value: result };
      let value = result;
      try {
        if (isNativePromise(result)) {
          value = Reflect.apply(promiseThen, result, [
            (resolved: unknown) => {
              end(span);
              return resolved;
            },
            (error: unknown) => {
              fail(span, error);
              throw error;
            },
          ]) as T;
        } else {
          end(span);
        }
      } catch {
        end(span);
        value = result;
      }
      outcome = { kind: "return", value };
      return value;
    });
    if (started) return outcome?.kind === "return" ? outcome.value : returned;
  } catch (error) {
    // Only reached from the guarded tracer or from `fn`; never call `fn` a second time.
    if (outcome?.kind === "return") return outcome.value;
    if (outcome?.kind === "throw") throw outcome.error;
    if (started) throw error;
  }
  // The tracer failed or never called back: run the function unobserved, once.
  let noop: ApiSpan;
  try {
    noop = trace.wrapSpanContext({
      traceId: "00000000000000000000000000000000",
      spanId: "0000000000000000",
      traceFlags: 0,
    });
  } catch {
    noop = trace.getActiveSpan() as ApiSpan;
  }
  return fn(noop);
}

const SKIP_OWN_KEYS: ReadonlySet<string | symbol> = new Set([
  "name",
  "length",
  "prototype",
  "arguments",
  "caller",
]);

// Metadata first (`@UseGuards`, `@SetMetadata`, `@Get`... applied before `@Span` define it on the
// original function), then own properties, then `name` and `length`.
function copyFunctionShape(
  from: (...args: never[]) => unknown,
  to: (...args: never[]) => unknown,
): void {
  for (const key of Reflect.getOwnMetadataKeys(from)) {
    Reflect.defineMetadata(key, Reflect.getOwnMetadata(key, from), to);
  }
  for (const key of Reflect.ownKeys(from)) {
    if (SKIP_OWN_KEYS.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(from, key);
    if (descriptor) Object.defineProperty(to, key, descriptor);
  }
  for (const key of ["name", "length"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(from, key);
    if (descriptor) Object.defineProperty(to, key, descriptor);
  }
}

function defaultName(target: object, propertyKey: string | symbol): string {
  try {
    const owner =
      typeof target === "function"
        ? (target as { name: string }).name
        : (target as { constructor: { name: string } }).constructor.name;
    return `${owner}.${String(propertyKey)}`;
  } catch {
    return String(propertyKey);
  }
}

/**
 * Method decorator: every call runs in a span named `name`, default `ClassName.method`. Decorators
 * stacked above or below it (`@Get`, `@UseGuards`, `@SetMetadata`) keep working: the replacement
 * function carries the original's reflect-metadata, own properties, `name` and `length`.
 */
export function Span(name?: string, options?: SpanOptions): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    try {
      const original: unknown = descriptor.value;
      if (typeof original !== "function") return descriptor;
      const spanName = name ?? defaultName(target, propertyKey);
      // Method shorthand: like a class method, the wrapper has no `prototype` and is not constructible.
      const wrapper = {
        wrapped(this: unknown, ...args: unknown[]): unknown {
          return withSpan(
            spanName,
            () => Reflect.apply(original, this, args),
            options,
          );
        },
      }.wrapped;
      copyFunctionShape(original as never, wrapper as never);
      descriptor.value = wrapper as typeof descriptor.value;
    } catch {
      // Leave the method as it was: no span is better than a broken method (rule 1).
    }
    return descriptor;
  };
}
