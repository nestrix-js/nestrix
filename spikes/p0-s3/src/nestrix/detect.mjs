// Detection probes that use only the stable, non-deprecated @opentelemetry/api
// surface. No ProxyTracerProvider.getDelegate(), no underscore members, no globals.

import {
  context,
  createContextKey,
  isSpanContextValid,
  propagation,
  ROOT_CONTEXT,
  TraceFlags,
  trace,
} from "@opentelemetry/api";

const PROBE_KEY = createContextKey("nestrix.detect.probe");

/**
 * True when some context manager is registered. The API's no-op manager ignores the
 * context passed to `with()`, so `active()` inside it is ROOT and the value is lost.
 * Synchronous only: a StackContextManager passes this probe.
 */
export function detectContextManager() {
  try {
    const marker = {};
    return context.with(
      ROOT_CONTEXT.setValue(PROBE_KEY, marker),
      () => context.active().getValue(PROBE_KEY) === marker,
    );
  } catch {
    return false;
  }
}

/** True when the registered manager also carries context across an async hop. */
export async function detectAsyncContextManager() {
  try {
    const marker = {};
    return await context.with(
      ROOT_CONTEXT.setValue(PROBE_KEY, marker),
      async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return context.active().getValue(PROBE_KEY) === marker;
      },
    );
  } catch {
    return false;
  }
}

/** True when a propagator is registered: the no-op propagator reports no fields. */
export function detectPropagator() {
  try {
    return propagation.fields().length > 0;
  } catch {
    return false;
  }
}

/** Which header fields the registered propagator writes (empty for the no-op one). */
export function propagatorFields() {
  try {
    return [...propagation.fields()];
  } catch {
    return [];
  }
}

/**
 * True when injecting a valid, sampled span context writes any header. A second way
 * to see a propagator, independent of what `fields()` claims.
 */
export function detectPropagatorByInject() {
  try {
    const carrier = {};
    const ctx = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
    propagation.inject(ctx, carrier);
    return Object.keys(carrier).length > 0;
  } catch {
    return false;
  }
}

/**
 * True when a tracer provider is registered: the API's proxy hands out a no-op tracer
 * whose spans have an invalid (all-zero) context until a delegate is set. Side effect:
 * on a real provider this starts a span (onStart runs in the host's processors), so it
 * is ended at once and shows up in the host's exporter. Not used by setupNestrix().
 */
export function detectTracerProviderByProbeSpan() {
  try {
    const span = trace
      .getTracer("nestrix-detect")
      .startSpan("nestrix.detect", {}, ROOT_CONTEXT);
    const valid = isSpanContextValid(span.spanContext());
    span.end();
    return valid;
  } catch {
    return false;
  }
}
