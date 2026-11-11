// Stand-in for Nestrix's OpenTelemetry setup code: the only place SDK packages are
// touched (AGENTS.md rule 5). ESM, so a CommonJS host gets the .mjs SDK copies here
// while its own code gets the .cjs copies (spike P0-S4).

import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { detectContextManager, detectPropagator } from "./detect.mjs";
import { subscribeHttpClient } from "./instrumentation.mjs";

/**
 * The store processor. Duck-typed: a plain object with the four methods the SDK's
 * SpanProcessor interface has, no class from any SDK copy, so it works with whichever
 * copy of the SDK built the host's provider. Every body catches everything: the SDK's
 * MultiSpanProcessor does not, so a throw here would surface in the host's
 * `startSpan` / `span.end()` and starve the processors after this one.
 *
 * forceFlush() and shutdown() never reject either: MultiSpanProcessor.shutdown() uses
 * Promise.all, so a rejection here would reject the host's provider.shutdown().
 *
 * `fault: "store"` makes the store throw on every add, inside the guard.
 * `fault: "lifecycle"` makes the flush/shutdown work throw, inside the guard.
 */
export function nestrixSpanProcessor(options = {}) {
  const max = options.max ?? 10_000;
  const spans = [];
  const stats = { started: 0, ended: 0, dropped: 0, faults: 0 };
  const add = (record) => {
    if (options.fault === "store") throw new Error("injected store fault");
    if (spans.length >= max) {
      spans.shift();
      stats.dropped++;
    }
    spans.push(record);
  };
  return {
    store: { spans, stats },
    onStart(_span, _parentContext) {
      try {
        stats.started++;
      } catch {
        stats.faults++;
      }
    },
    onEnd(span) {
      try {
        stats.ended++;
        const sc = span.spanContext();
        add({
          name: span.name,
          kind: span.kind,
          traceId: sc.traceId,
          spanId: sc.spanId,
          parentSpanId: span.parentSpanContext?.spanId,
          scope: span.instrumentationScope?.name,
          attributes: { ...span.attributes },
          status: span.status?.code,
        });
      } catch {
        stats.faults++;
      }
    },
    forceFlush() {
      return settle(() => lifecycleWork(options));
    },
    shutdown() {
      return settle(() => lifecycleWork(options));
    },
  };
}

async function lifecycleWork(options) {
  if (options.fault === "lifecycle")
    throw new Error("injected lifecycle fault");
}

/** Runs fn and resolves whatever it does (throws, rejects, or resolves). */
function settle(fn) {
  try {
    return Promise.resolve(fn()).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}

/**
 * What Nestrix does at startup. Provider: try to register (the architecture's
 * mechanism; `false` means a host provider exists). Context manager and propagator:
 * probe first (detect.mjs), register only when nothing is there.
 */
export function setupNestrix(options = {}) {
  const result = { log: [] };
  const processor = options.processor ?? nestrixSpanProcessor();
  result.processor = processor;

  const provider = new TracerProvider({ spanProcessors: [processor] });
  result.providerRegistered = trace.setGlobalTracerProvider(provider);
  if (result.providerRegistered) {
    result.provider = provider;
  } else {
    provider.shutdown().catch(() => {});
    result.log.push(
      "a tracer provider is already registered; add nestrixSpanProcessor() to its spanProcessors for the dashboard",
    );
  }

  result.contextManagerDetected = detectContextManager();
  if (!result.contextManagerDetected) {
    const cm = new AsyncLocalStorageContextManager();
    result.contextManagerRegistered = context.setGlobalContextManager(
      cm.enable(),
    );
    if (!result.contextManagerRegistered) cm.disable();
  }

  result.propagatorDetected = detectPropagator();
  if (!result.propagatorDetected) {
    result.propagatorRegistered = propagation.setGlobalPropagator(
      new W3CTraceContextPropagator(),
    );
  }

  if (options.undici !== false) {
    // requireParentforSpans: no client span and no header without an active parent.
    // Suppressed tracing is already honoured by the instrumentation.
    result.undici = new UndiciInstrumentation({ requireParentforSpans: true });
  }
  if (options.http !== false) subscribeHttpClient();
  return result;
}

export {
  faults,
  httpSkips,
  NestrixStandInModule,
  routeStats,
} from "./instrumentation.mjs";
