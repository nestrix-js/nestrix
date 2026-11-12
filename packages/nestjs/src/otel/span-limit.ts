/**
 * `maxSpansPerTrace` on a Nestrix-owned provider (D-78, P13-01): a sampler wrapped around the
 * provider's `ParentBasedSampler`, and a span processor that writes the dropped counts on each
 * local root as it ends. Setup code (rule 5): the only place the SDK's sampler and processor
 * interfaces are implemented. The counting itself is `../trace-limit.ts`.
 *
 * Facts this rests on (sdk-trace 3.1.1, `dist/Tracer.mjs` `startSpan`, `dist/Span.mjs` `end`):
 * - The sampler runs for every span the provider's tracers start, before the span exists, with the
 *   parent context, the trace id, the span kind and the start attributes. A `NOT_RECORD` decision
 *   returns `trace.wrapSpanContext(...)`: no `SpanImpl`, no processor call, and trace flags
 *   `NONE` (the flags are `SAMPLED` only for `RECORD_AND_SAMPLED`; a sampler cannot ask for a
 *   non-recording span that stays sampled). So a dropped span's context, and every `traceparent`
 *   sent from inside it, carries `-00`.
 * - `ParentBasedSampler` answers `NOT_RECORD` for a child of a local unsampled parent, so children
 *   of a dropped span are dropped without asking the counter; the wrapper counts them.
 * - `Span.end()` calls `spanProcessor.onEnding(span)` (when defined) before it sets `_ended`, then
 *   `onEnd`; `MultiSpanProcessor` forwards `onEnding` to every processor that has it. Attributes set
 *   in `onEnding` therefore reach every processor's `onEnd` and the exporter. `onEnding` is marked
 *   `@experimental` in `SpanProcessor.d.mts`; `span-limit.test.ts` pins it, and if a later SDK
 *   stops calling it the processor notices in `onEnd`, keeps the map clean and logs once.
 */
import {
  type Attributes,
  type Context,
  type Link,
  SamplingDecision,
  type SpanKind,
} from "@opentelemetry/api";
import type {
  ReadableSpan,
  Sampler,
  SamplingResult,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace";
import type { TraceSpanCounter } from "../trace-limit.js";
import type { TelemetryDiagnostics } from "./types.js";

/**
 * `inner` decides as before; a span it would record is then counted, and past the limit the
 * answer becomes `NOT_RECORD`. A span `inner` does not record is counted as dropped when its trace
 * is over the limit (its parent was dropped). A fault in the counting returns `inner`'s answer.
 */
export function createLimitingSampler(
  inner: Sampler,
  counter: TraceSpanCounter,
  diagnostics: TelemetryDiagnostics,
): Sampler {
  return {
    shouldSample(
      context: Context,
      traceId: string,
      spanName: string,
      spanKind: SpanKind,
      attributes: Attributes,
      links: Link[],
    ): SamplingResult {
      const result = inner.shouldSample(
        context,
        traceId,
        spanName,
        spanKind,
        attributes,
        links,
      );
      try {
        if (result.decision === SamplingDecision.NOT_RECORD) {
          counter.dropDescendant(traceId, spanKind, attributes);
          return result;
        }
        if (counter.tryRecord(traceId, spanKind, attributes)) {
          return result;
        }
        return {
          decision: SamplingDecision.NOT_RECORD,
          traceState: result.traceState,
        };
      } catch (error) {
        diagnostics.countFailure("trace-limit.sampler", error);
        return result;
      }
    },
    toString() {
      return `NestrixSpanLimit{limit=${counter.limit}, ${String(inner)}}`;
    },
  };
}

function isLocalRoot(span: ReadableSpan): boolean {
  const parent = span.parentSpanContext;
  return parent === undefined || parent.isRemote === true;
}

/**
 * Writes the dropped counts on each local root in `onEnding`. First in the provider's processor
 * list, though `onEnding` runs for every processor before any `onEnd`. Never throws.
 */
export function createSpanLimitProcessor(
  counter: TraceSpanCounter,
  diagnostics: TelemetryDiagnostics,
): SpanProcessor {
  let sawEnding = false;
  return {
    // Runs only for spans the sampler let through (`Span.mjs` constructor), right after it.
    onStart(span: Span) {
      try {
        if (isLocalRoot(span)) counter.rootStarted(span.spanContext().traceId);
      } catch (error) {
        diagnostics.countFailure("trace-limit.onStart", error);
      }
    },
    onEnding(span: Span) {
      try {
        sawEnding = true;
        if (!isLocalRoot(span)) return;
        counter.rootEnding(span.spanContext().traceId, span);
      } catch (error) {
        diagnostics.countFailure("trace-limit.onEnding", error);
      }
    },
    onEnd(span: ReadableSpan) {
      try {
        if (sawEnding || !isLocalRoot(span)) return;
        // The SDK did not call onEnding: forget the trace so the map stays small; the counts
        // cannot be written on an ended span.
        counter.rootEnding(span.spanContext().traceId, { setAttribute: noop });
        diagnostics.logOnce(
          "trace-limit.no-onEnding",
          "This OpenTelemetry SDK does not call SpanProcessor.onEnding, so maxSpansPerTrace still limits spans but cannot write nestrix.trace.spans_dropped on the trace's root span.",
        );
      } catch (error) {
        diagnostics.countFailure("trace-limit.onEnd", error);
      }
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

function noop(this: unknown): never {
  return this as never;
}
