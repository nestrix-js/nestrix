/**
 * `bullmqTelemetry()`: BullMQ's `Telemetry` interface on Nestrix's own copy of
 * `@opentelemetry/api` (issue #20, D-81).
 *
 * Why it exists: `bullmq-otel` 2.0 is CommonJS only, so in an ESM app it loads the CommonJS build
 * of `@opentelemetry/api` while Nestrix loads the ESM build. The two copies share the globals but
 * each has its own fallback proxy tracer provider. `new BullMQOtel()` takes its tracer in its
 * constructor; written inline in `BullModule.forRoot()` that runs when the module file is
 * imported, before Nestrix registers its provider, so it gets a proxy of the CommonJS copy's
 * fallback provider, which never receives a delegate: BullMQ's spans are no-ops for the life of
 * the process. Propagation still works (the propagator is read from the shared global on each
 * call), which hides the problem.
 *
 * This helper resolves its tracer on use instead, through the API copy Nestrix itself uses, and
 * re-resolves it whenever the global tracer provider object changes. It is structural: no import
 * of `bullmq` or `bullmq-otel` (no runtime dependency, D-81), and it matches BullMQ 6.7's
 * `Telemetry`, `Tracer`, `Span`, `ContextManager` and `Meter` interfaces.
 *
 * Adapted from bullmq-otel 2.0.1 (its published dist/esm/bullMQOtel.js), under the MIT licence:
 *   Copyright (c) 2024 BullForce Labs AB
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 *   and associated documentation files (the "Software"), to deal in the Software without
 *   restriction, including without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions: The above copyright
 *   notice and this permission notice shall be included in all copies or substantial portions of
 *   the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 *   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 *   LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 *   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 *   DEALINGS IN THE SOFTWARE.
 *
 * Differences from bullmq-otel, each deliberate:
 * - The tracer (and meter) is resolved lazily, on the API copy Nestrix uses.
 * - Every method catches everything (rule 1): BullMQ calls these inside `queue.add()` and job
 *   processing, so a throw here would fail the host's call. Malformed job metadata (it comes
 *   from Redis) gives the active context instead of throwing.
 * - `recordException` also sets the span's status to error, and BullMQ's "job failed" event
 *   records an exception (the failed reason as its message) and error status on the `process`
 *   span; BullMQ's `Span` interface has no `setStatus`, so a failed job was not an error.
 * - The "job completed" event drops `bullmq.job.result` (the job's return value, JSON): like a
 *   response body, it is not recorded (AGENTS.md rule 7).
 * - `contextManager.root()` is implemented (BullMQ 6.7 uses it to run the stalled-jobs checker
 *   outside the context that started the worker).
 * - With `contextPropagation.keys` (D-102), the job metadata's `baggage` carries those keys of the
 *   queuing work's trace attributes, and the worker sets them on the job's consumer span.
 * - An internal span with no parent (the stalled-jobs check every 30 s per worker, `close` at
 *   shutdown) is not recorded unless `rootSpans` is true, like root Redis commands (D-60).
 */
import {
  type Attributes,
  type Context,
  context,
  isSpanContextValid,
  type Meter,
  type MeterProvider,
  metrics,
  type Span as OtelSpan,
  type Tracer as OtelTracer,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type TimeInput,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";
import {
  addBaggageToCarrier,
  applyInboundBaggage,
  withInboundBaggage,
} from "../context/trace-attributes.js";
import { diagnostics } from "../diagnostics.js";
import {
  forgetAttempt,
  JOB_ATTEMPT_KEY,
  recordExceptionEvent,
  withLocalRoot,
} from "../errors/exception.js";

/** Options of `bullmqTelemetry()`. */
export interface BullmqTelemetryOptions {
  /** The instrumentation scope name of BullMQ's spans. Default `"bullmq"`. */
  readonly tracerName?: string;
  /** The scope version of the tracer and the meter. */
  readonly version?: string;
  /**
   * Also give BullMQ a meter, for its job counters, job duration histogram and queue gauge.
   * Default `false`. They go to the global `MeterProvider` (Nestrix's, with `metrics` on).
   */
  readonly enableMetrics?: boolean;
  /** The meter's scope name. Default: `tracerName`. */
  readonly meterName?: string;
  /**
   * Keep BullMQ's internal spans that have no parent: the stalled-jobs check that runs every
   * `stalledInterval` in each worker (`moveStalledJobsToWait <queue>`), its timer, and the
   * `close` of each queue and worker at shutdown. Default `false`: each would be a trace of its
   * own, every 30 seconds per worker, crowding out the traces of requests and jobs. Producer
   * (`add`) and consumer (`process`) spans are always kept, with or without a parent.
   */
  readonly rootSpans?: boolean;
}

/** Attribute values as BullMQ passes them (`AttributeValue` in bullmq's telemetry types). */
export type BullmqAttributeValue =
  | string
  | number
  | boolean
  | Array<null | undefined | string>
  | Array<null | undefined | number>
  | Array<null | undefined | boolean>;

/** Attributes as BullMQ passes them. */
export interface BullmqAttributes {
  [attribute: string]: BullmqAttributeValue | undefined;
}

/** BullMQ's `Span`, structurally. */
export interface BullmqSpan {
  setSpanOnContext(ctx: Context): Context;
  setAttribute(key: string, value: BullmqAttributeValue): void;
  setAttributes(attributes: BullmqAttributes): void;
  addEvent(name: string, attributes?: BullmqAttributes): void;
  // biome-ignore lint/suspicious/noExplicitAny: BullMQ's own Exception and Time types, structurally
  recordException(exception: any, time?: any): void;
  end(): void;
}

/** BullMQ's `Telemetry`, structurally: pass it as `telemetry` to BullMQ or `@nestjs/bullmq`. */
export interface BullmqTelemetry {
  readonly tracer: {
    startSpan(
      name: string,
      options?: { kind: number },
      context?: Context,
    ): BullmqSpan;
  };
  readonly contextManager: {
    // biome-ignore lint/suspicious/noExplicitAny: mirrors BullMQ's ContextManager.with signature
    with<A extends (...args: any[]) => any>(
      context: Context,
      fn: A,
    ): ReturnType<A>;
    active(): Context;
    root(): Context;
    getMetadata(context: Context): string;
    fromMetadata(activeContext: Context, metadata: string): Context;
  };
  readonly meter?: {
    createCounter(
      name: string,
      options?: { description?: string; unit?: string },
    ): { add(value: number, attributes?: BullmqAttributes): void };
    createHistogram(
      name: string,
      options?: { description?: string; unit?: string },
    ): { record(value: number, attributes?: BullmqAttributes): void };
    createGauge(
      name: string,
      options?: { description?: string; unit?: string },
    ): { record(value: number, attributes?: BullmqAttributes): void };
  };
}

/** BullMQ's event on the `process` span when the job failed (bullmq 6.7 worker.js). */
const JOB_FAILED_EVENT = "job failed";
const ATTR_FAILED_REASON = "bullmq.job.failed.reason";
/** The job's return value, JSON, on the "job completed" event: never recorded. */
const ATTR_JOB_RESULT = "bullmq.job.result";

const KINDS: ReadonlySet<number> = new Set([
  SpanKind.INTERNAL,
  SpanKind.SERVER,
  SpanKind.CLIENT,
  SpanKind.PRODUCER,
  SpanKind.CONSUMER,
]);

function fail(where: string, error: unknown): void {
  diagnostics.countFailure(`jobs.bullmq.${where}`, error);
}

/** Wraps one OpenTelemetry span in BullMQ's `Span` shape. */
class JobSpan implements BullmqSpan {
  readonly #span: OtelSpan;
  /** The context the span was started in: decides whether it is a local root (`recordError`). */
  readonly #parent: Context;

  /** A consumer span: one job attempt; its id keys the attempt's messages (D-93). */
  readonly #attempt: string | undefined;

  constructor(span: OtelSpan, parent: Context, kind: SpanKind) {
    this.#span = span;
    this.#parent = parent;
    let attempt: string | undefined;
    if (kind === SpanKind.CONSUMER) {
      try {
        attempt = span.spanContext().spanId;
      } catch {
        attempt = undefined;
      }
    }
    this.#attempt = attempt;
    // D-102: allow-listed keys the job brought in its metadata's baggage go on its root span.
    if (kind === SpanKind.CONSUMER) applyInboundBaggage(parent, span);
  }

  setSpanOnContext(ctx: Context): Context {
    try {
      const withRoot = withLocalRoot(
        this.#parent,
        this.#span,
        trace.setSpan(ctx, this.#span),
      );
      return this.#attempt === undefined
        ? withRoot
        : withRoot.setValue(JOB_ATTEMPT_KEY, this.#attempt);
    } catch (error) {
      fail("span", error);
      return ctx;
    }
  }

  setAttribute(key: string, value: BullmqAttributeValue): void {
    try {
      this.#span.setAttribute(key, value);
    } catch (error) {
      fail("span", error);
    }
  }

  setAttributes(attributes: BullmqAttributes): void {
    try {
      this.#span.setAttributes(attributes as Attributes);
    } catch (error) {
      fail("span", error);
    }
  }

  addEvent(
    name: string,
    attributes?: BullmqAttributes,
    time?: TimeInput,
  ): void {
    try {
      let recorded = attributes;
      if (attributes !== undefined && ATTR_JOB_RESULT in attributes) {
        const { [ATTR_JOB_RESULT]: _dropped, ...rest } = attributes;
        recorded = rest;
      }
      this.#span.addEvent(name, recorded as Attributes | undefined, time);
      if (name === JOB_FAILED_EVENT) {
        const reason = attributes?.[ATTR_FAILED_REASON];
        // BullMQ passes only `err.message`: when the processor's method span already recorded
        // an unexpected error with that message in this attempt, this event is marked
        // propagated (one occurrence, D-93). A failed attempt is never expected (D-94).
        try {
          recordExceptionEvent(
            this.#span,
            typeof reason === "string" && reason !== "" ? reason : "job failed",
            { byMessage: true, expected: false, time },
          );
        } catch (error) {
          fail("span", error);
        }
        this.#span.setStatus({ code: SpanStatusCode.ERROR });
      }
    } catch (error) {
      fail("span", error);
    }
  }

  recordException(exception: unknown, time?: TimeInput): void {
    try {
      recordExceptionEvent(
        this.#span,
        typeof exception === "string" ||
          (typeof exception === "object" && exception !== null)
          ? exception
          : String(exception),
        typeof exception === "string"
          ? { byMessage: true, expected: false, time }
          : // A consumer span is the attempt's outermost span: errors below travelled up (D-93).
            { root: this.#attempt !== undefined, time },
      );
    } catch (error) {
      fail("span", error);
    }
    try {
      this.#span.setStatus({ code: SpanStatusCode.ERROR });
    } catch (error) {
      fail("span", error);
    }
  }

  end(): void {
    if (this.#attempt !== undefined) forgetAttempt(this.#attempt);
    try {
      this.#span.end();
    } catch (error) {
      fail("span", error);
    }
  }
}

/** What BullMQ gets when a span could not be started: does nothing, keeps the context. */
const NOOP_SPAN: BullmqSpan = Object.freeze({
  setSpanOnContext: (ctx: Context) => ctx,
  setAttribute() {},
  setAttributes() {},
  addEvent() {},
  recordException() {},
  end() {},
});

/** A tracer resolved on use, again whenever the global tracer provider object changes. */
function lazyTracer(
  name: string,
  version: string | undefined,
  rootSpans: boolean,
) {
  let provider: TracerProvider | undefined;
  let tracer: OtelTracer | undefined;
  const current = (): OtelTracer => {
    const now = trace.getTracerProvider();
    if (tracer === undefined || now !== provider) {
      tracer = now.getTracer(name, version);
      provider = now;
    }
    return tracer;
  };
  return {
    startSpan(
      spanName: string,
      options?: { kind: number },
      ctx?: Context,
    ): BullmqSpan {
      try {
        const requested = options?.kind;
        const kind =
          typeof requested === "number" && KINDS.has(requested)
            ? (requested as SpanKind)
            : SpanKind.INTERNAL;
        if (kind === SpanKind.INTERNAL && !rootSpans) {
          const parent = trace.getSpanContext(ctx ?? context.active());
          if (parent === undefined || !isSpanContextValid(parent)) {
            return NOOP_SPAN;
          }
        }
        const parent = ctx ?? context.active();
        const span = current().startSpan(spanName, { kind }, parent);
        return new JobSpan(span, parent, kind);
      } catch (error) {
        fail("tracer", error);
        return NOOP_SPAN;
      }
    },
  };
}

const contextManager: BullmqTelemetry["contextManager"] = Object.freeze({
  // biome-ignore lint/suspicious/noExplicitAny: mirrors BullMQ's ContextManager.with signature
  with<A extends (...args: any[]) => any>(ctx: Context, fn: A): ReturnType<A> {
    let entered = false;
    // biome-ignore lint/suspicious/noExplicitAny: forwarded as is
    const run = ((...args: any[]) => {
      entered = true;
      return fn(...args);
    }) as A;
    try {
      return context.with(ctx, run);
    } catch (error) {
      // An error from fn is the host's: rethrow it. One from the context manager is ours: run
      // fn without it, exactly once.
      if (entered) throw error;
      fail("context", error);
      return fn();
    }
  },
  active(): Context {
    try {
      return context.active();
    } catch (error) {
      fail("context", error);
      return ROOT_CONTEXT;
    }
  },
  root(): Context {
    return ROOT_CONTEXT;
  },
  getMetadata(ctx: Context): string {
    try {
      const carrier: Record<string, string> = {};
      propagation.inject(ctx, carrier);
      // D-102: only with `contextPropagation.keys`; otherwise the carrier is left as it is.
      addBaggageToCarrier(ctx, carrier);
      return JSON.stringify(carrier);
    } catch (error) {
      fail("context", error);
      return "{}";
    }
  },
  fromMetadata(activeContext: Context, metadata: string): Context {
    try {
      const carrier: unknown = JSON.parse(metadata);
      if (
        carrier === null ||
        typeof carrier !== "object" ||
        Array.isArray(carrier)
      ) {
        return activeContext;
      }
      return withInboundBaggage(
        propagation.extract(activeContext, carrier),
        carrier,
      );
    } catch (error) {
      fail("context", error);
      return activeContext;
    }
  },
});

type Instrument = {
  add?(value: number, attributes?: Attributes): void;
  record?(value: number, attributes?: Attributes): void;
};
type InstrumentKind = "counter" | "histogram" | "gauge";

/** A meter whose instruments are resolved on each use against the current global provider. */
function lazyMeter(
  name: string,
  version: string | undefined,
): NonNullable<BullmqTelemetry["meter"]> {
  let provider: MeterProvider | undefined;
  let meter: Meter | undefined;
  const instruments = new Map<string, Instrument>();
  const wrappers = new Map<string, unknown>();
  const instrument = (
    kind: InstrumentKind,
    instrumentName: string,
    options: { description?: string; unit?: string } | undefined,
  ): Instrument => {
    const now = metrics.getMeterProvider();
    if (meter === undefined || now !== provider) {
      meter = now.getMeter(name, version);
      provider = now;
      instruments.clear();
    }
    const key = `${kind}:${instrumentName}`;
    let found = instruments.get(key);
    if (found === undefined) {
      found =
        kind === "counter"
          ? meter.createCounter(instrumentName, options)
          : kind === "histogram"
            ? meter.createHistogram(instrumentName, options)
            : meter.createGauge(instrumentName, options);
      instruments.set(key, found);
    }
    return found;
  };
  const wrapper = <T>(
    kind: InstrumentKind,
    instrumentName: string,
    options: { description?: string; unit?: string } | undefined,
    make: (use: () => Instrument) => T,
  ): T => {
    const key = `${kind}:${instrumentName}`;
    let found = wrappers.get(key) as T | undefined;
    if (found === undefined) {
      found = make(() => instrument(kind, instrumentName, options));
      wrappers.set(key, found);
    }
    return found;
  };
  const record =
    (use: () => Instrument) =>
    (value: number, attributes?: BullmqAttributes): void => {
      try {
        use().record?.(value, attributes as Attributes | undefined);
      } catch (error) {
        fail("meter", error);
      }
    };
  return Object.freeze({
    createCounter: (n: string, o?: { description?: string; unit?: string }) =>
      wrapper("counter", n, o, (use) => ({
        add(value: number, attributes?: BullmqAttributes): void {
          try {
            use().add?.(value, attributes as Attributes | undefined);
          } catch (error) {
            fail("meter", error);
          }
        },
      })),
    createHistogram: (n: string, o?: { description?: string; unit?: string }) =>
      wrapper("histogram", n, o, (use) => ({ record: record(use) })),
    createGauge: (n: string, o?: { description?: string; unit?: string }) =>
      wrapper("gauge", n, o, (use) => ({ record: record(use) })),
  });
}

/**
 * BullMQ telemetry on Nestrix's OpenTelemetry API: pass it as `telemetry` to
 * `BullModule.forRoot()` (or to a BullMQ `Queue`, `Worker` or `FlowProducer`). BullMQ then
 * records its producer (`add <queue>.<job>`), consumer (`process <queue>`) and outcome
 * (`complete <queue>`, `fail <queue>`) spans and carries the trace context in each job.
 *
 * Safe to create at any time, before or after Nestrix starts: the tracer is looked up when
 * BullMQ first uses it. Needs no `bullmq-otel`.
 */
export function bullmqTelemetry(
  options: BullmqTelemetryOptions = {},
): BullmqTelemetry {
  let tracerName = "bullmq";
  let version: string | undefined;
  let enableMetrics = false;
  let meterName: string | undefined;
  let rootSpans = false;
  try {
    if (typeof options?.tracerName === "string" && options.tracerName !== "")
      tracerName = options.tracerName;
    if (typeof options?.version === "string") version = options.version;
    enableMetrics = options?.enableMetrics === true;
    if (typeof options?.meterName === "string" && options.meterName !== "")
      meterName = options.meterName;
    rootSpans = options?.rootSpans === true;
  } catch (error) {
    fail("options", error);
  }
  return {
    tracer: lazyTracer(tracerName, version, rootSpans),
    contextManager,
    ...(enableMetrics
      ? { meter: lazyMeter(meterName ?? tracerName, version) }
      : {}),
  };
}
