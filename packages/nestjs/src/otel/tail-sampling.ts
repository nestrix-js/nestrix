/**
 * The sampler and span processor of the local tail decision (issue #43, D-100) and the keep
 * probability written on each local root (issue #30). Setup code (rule 5): the only place these
 * SDK interfaces are implemented for sampling; the shared per-trace state is `../tail-sampling.ts`.
 *
 * Facts this rests on (sdk-trace 3.1.1, `dist/Tracer.mjs` `startSpan`, `dist/Span.mjs` `end`,
 * `dist/export/BatchSpanProcessorBase.mjs` `onEnd`):
 * - A `RECORD` decision makes a full `SpanImpl` with trace flags `NONE`: processors see it, and its
 *   context (and every `traceparent` sent from inside it) carries `-00`, the head decision.
 * - `BatchSpanProcessor.onEnd` ignores a span without the `SAMPLED` flag, so a kept span is handed
 *   on as a view whose `spanContext()` has the flag set; every other field is the span's own.
 * - `Span.end()` sets `endTime` and the duration, then calls `onEnding` (the span is still
 *   writable: the probability is written there), then `onEnd`. When an SDK does not call
 *   `onEnding`, the decision is taken in `onEnd` and no probability is written (logged once).
 */
import {
  type Attributes,
  type Context,
  isSpanContextValid,
  type Link,
  SamplingDecision,
  type SpanContext,
  type SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import type {
  ReadableSpan,
  Sampler,
  SamplingResult,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace";
import type { TraceLogInput } from "../logs/sink.js";
import { getTraceLogSink } from "../logs/sink.js";
import { ATTR_EXCEPTION_EXPECTED } from "../store/error-facts.js";
import {
  ATTR_SAMPLING_PROBABILITY,
  type TailRegistry,
} from "../tail-sampling.js";
import { settle } from "./redacting-exporter.js";
import type { TelemetryDiagnostics } from "./types.js";

/** What the tail decision keeps besides the ratio's sample. */
export interface TailRules {
  /** Keep a trace in which a span failed (D-94: unexpected errors only). */
  readonly keepErrors: boolean;
  /** Keep a trace whose local root took longer than this many ms; `false`: off. */
  readonly keepSlowerThanMs: number | false;
}

/** Whether the tail decision runs: only below rate 1, and only when a rule can keep something. */
export function tailActive(sampleRate: number, rules: TailRules): boolean {
  return (
    sampleRate < 1 && (rules.keepErrors || rules.keepSlowerThanMs !== false)
  );
}

/**
 * Around the provider's `ParentBasedSampler`: a new root the ratio did not sample, and a child of
 * a local parent of a trace still being recorded for the decision, become `RECORD` instead of
 * `NOT_RECORD`. A child of an unsampled remote parent stays `NOT_RECORD` (D-100: the upstream
 * service decided). A fault returns the inner answer.
 */
export function createTailSampler(
  inner: Sampler,
  registry: TailRegistry<unknown>,
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
        if (result.decision !== SamplingDecision.NOT_RECORD) return result;
        const parent = trace.getSpanContext(context);
        const record: SamplingResult = {
          decision: SamplingDecision.RECORD,
          attributes: result.attributes,
          traceState: result.traceState,
        };
        if (parent === undefined || !isSpanContextValid(parent)) return record;
        if (parent.isRemote === true) return result;
        if ((parent.traceFlags & TraceFlags.SAMPLED) !== 0) return result;
        return registry.isRecording(traceId) ? record : result;
      } catch (error) {
        diagnostics.countFailure("tail-sampling.sampler", error);
        return result;
      }
    },
    toString() {
      return `NestrixTailSampling{${String(inner)}}`;
    },
  };
}

function isSampled(sc: SpanContext): boolean {
  return (sc.traceFlags & TraceFlags.SAMPLED) !== 0;
}

/** No parent, or a remote one: the first span of the trace in this process. */
function isLocalRoot(span: ReadableSpan): boolean {
  const parent = span.parentSpanContext;
  return parent === undefined || parent.isRemote === true;
}

/** Status error, unless every exception event on the span is expected (D-94, `isFailedSpan`). */
export function spanFailed(span: ReadableSpan): boolean {
  if (span.status?.code !== SpanStatusCode.ERROR) return false;
  let exceptions = 0;
  for (const event of span.events ?? []) {
    if (event.name !== "exception") continue;
    exceptions++;
    const expected = event.attributes?.[ATTR_EXCEPTION_EXPECTED];
    if (expected !== true && expected !== "true") return true;
  }
  return exceptions === 0;
}

function durationMs(span: ReadableSpan): number {
  const d = span.duration;
  return Array.isArray(d) ? d[0] * 1e3 + d[1] / 1e6 : 0;
}

/**
 * A view of a kept span with the `SAMPLED` flag, so the batch processor exports it. Every other
 * property is read from the span itself (SDK 3's `SpanImpl` keeps its state in plain fields).
 */
function asSampled(span: ReadableSpan): ReadableSpan {
  const sc = span.spanContext();
  const sampled: SpanContext = {
    ...sc,
    traceFlags: sc.traceFlags | TraceFlags.SAMPLED,
  };
  return Object.create(span, {
    spanContext: { value: () => sampled, enumerable: false },
  }) as ReadableSpan;
}

export interface SamplingProcessorOptions {
  readonly sampleRate: number;
  readonly rules: TailRules;
  /** Set when the tail decision runs (`tailActive`); otherwise spans pass straight through. */
  readonly registry: TailRegistry<unknown> | undefined;
  /** The export chain and the dashboard store's processor: what kept spans are handed to. */
  readonly inner: readonly SpanProcessor[];
  readonly diagnostics: TelemetryDiagnostics;
}

/**
 * Writes the keep probability on each local root in `onEnding` and, when the tail decision runs,
 * holds the spans of unsampled traces until their root ends. Every method catches everything; a
 * fault in the decision passes the span on as before (sampled) or drops it (unsampled).
 */
export function createSamplingProcessor(
  options: SamplingProcessorOptions,
): SpanProcessor {
  const { sampleRate, rules, registry, inner, diagnostics } = options;
  let sawEnding = false;

  const forward = (span: ReadableSpan): void => {
    for (const p of inner) {
      try {
        p.onEnd(span);
      } catch (error) {
        diagnostics.countFailure("tail-sampling.forward", error);
      }
    }
  };

  const releaseLogs = (logs: readonly TraceLogInput[]): void => {
    if (logs.length === 0) return;
    try {
      const sink = getTraceLogSink();
      if (sink === undefined) return;
      for (const log of logs) sink.add(log);
    } catch (error) {
      diagnostics.countFailure("tail-sampling.logs", error);
    }
  };

  /** Whether a rule keeps the trace whatever the ratio said. */
  const forced = (span: ReadableSpan, traceFailed: boolean): boolean =>
    (rules.keepErrors && (traceFailed || spanFailed(span))) ||
    (rules.keepSlowerThanMs !== false &&
      durationMs(span) > rules.keepSlowerThanMs);

  return {
    onStart(span: Span, parentContext: Context) {
      try {
        if (
          registry !== undefined &&
          span.parentSpanContext === undefined &&
          !isSampled(span.spanContext())
        ) {
          registry.rootStarted(span.spanContext().traceId);
        }
      } catch (error) {
        diagnostics.countFailure("tail-sampling.onStart", error);
      }
      for (const p of inner) {
        try {
          p.onStart(span, parentContext);
        } catch (error) {
          diagnostics.countFailure("tail-sampling.forward", error);
        }
      }
    },

    onEnding(span: Span) {
      try {
        sawEnding = true;
        if (!isLocalRoot(span)) return;
        const sc = span.spanContext();
        const sampled = isSampled(sc);
        // The sampled-trace failure note is consumed in every case, so the set stays small.
        const childFailed = sampled
          ? (registry?.takeSampledFailure(sc.traceId) ?? false)
          : (registry?.hasFailed(sc.traceId) ?? false);
        // A remote parent decided: the probability is the upstream service's, unknown here.
        if (span.parentSpanContext?.isRemote === true) return;
        const keep = forced(span, childFailed);
        if (sampled) {
          span.setAttribute(ATTR_SAMPLING_PROBABILITY, keep ? 1 : sampleRate);
          return;
        }
        if (registry === undefined) return;
        registry.setRootDecision(sc.traceId, keep);
        if (keep) span.setAttribute(ATTR_SAMPLING_PROBABILITY, 1);
      } catch (error) {
        diagnostics.countFailure("tail-sampling.onEnding", error);
      }
    },

    onEnd(span: ReadableSpan) {
      let sc: SpanContext;
      try {
        sc = span.spanContext();
      } catch (error) {
        diagnostics.countFailure("tail-sampling.onEnd", error);
        return;
      }
      if (registry === undefined || isSampled(sc)) {
        try {
          if (
            registry !== undefined &&
            span.parentSpanContext !== undefined &&
            span.parentSpanContext.isRemote !== true &&
            spanFailed(span)
          ) {
            registry.noteSampledFailure(sc.traceId);
          }
        } catch (error) {
          diagnostics.countFailure("tail-sampling.onEnd", error);
        }
        forward(span);
        return;
      }
      try {
        if (span.parentSpanContext === undefined) {
          let keep = registry.takeRootDecision(sc.traceId);
          if (keep === undefined) {
            keep = forced(span, registry.hasFailed(sc.traceId));
            if (!sawEnding) {
              diagnostics.logOnce(
                "tail-sampling.no-onEnding",
                "This OpenTelemetry SDK does not call SpanProcessor.onEnding, so Nestrix still keeps failed and slow traces when sampling but cannot write nestrix.sampling.probability on their root spans; the standalone server then counts them without weights.",
              );
            }
          }
          const released = registry.rootEnded(sc.traceId, keep);
          if (released === undefined) {
            // The trace was evicted at the bound: its spans were counted, and so is its root.
            registry.countDropped(1);
            return;
          }
          if (!keep) return;
          for (const held of released.spans as ReadableSpan[])
            forward(asSampled(held));
          forward(asSampled(span));
          // The lines of a kept trace go to the store after its spans, as for a sampled trace.
          releaseLogs(released.logs);
          return;
        }
        const outcome = registry.childEnded(sc.traceId, span, spanFailed(span));
        if (outcome === "pass") forward(asSampled(span));
      } catch (error) {
        diagnostics.countFailure("tail-sampling.onEnd", error);
      }
    },

    forceFlush() {
      // Undecided traces are not done yet; only what was handed on is flushed.
      return Promise.all(inner.map((p) => settle(() => p.forceFlush()))).then(
        () => undefined,
        () => undefined,
      );
    },

    shutdown() {
      try {
        registry?.clear();
      } catch (error) {
        diagnostics.countFailure("tail-sampling.shutdown", error);
      }
      return Promise.all(inner.map((p) => settle(() => p.shutdown()))).then(
        () => undefined,
        () => undefined,
      );
    },
  };
}
