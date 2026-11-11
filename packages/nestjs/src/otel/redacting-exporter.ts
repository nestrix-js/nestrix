/**
 * Wraps the OTLP exporter so that Nestrix's redaction (`scrub`) and the user's `redact`
 * hook run on every span before the exporter sees it.
 *
 * Why an exporter wrapper and not a span processor: in `onEnd` the span is a read-only
 * `ReadableSpan`, and SDK 3.1.1's `onEnding` (where the span is still writable) is marked
 * experimental, can only `setAttribute` (no delete, no event edits) and cannot drop a span
 * (`sdk-trace/dist/SpanProcessor.d.mts`, `Span.mjs:188`). Here each span is copied into a
 * plain object the hooks may change freely, and the copy is what gets exported.
 *
 * Runs on the batch processor's timer, never in a request path. Every method catches
 * everything; the result callback is called exactly once per `export`.
 */
import type {
  Attributes,
  AttributeValue,
  SpanStatus,
} from "@opentelemetry/api";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type {
  ReadableSpan,
  SpanExporter,
  TimedEvent,
} from "@opentelemetry/sdk-trace";
import type { RedactableSpan, RedactHook } from "../options.js";
import type { TelemetryDiagnostics } from "./types.js";

export interface RedactionCounters {
  exportedSpans: number;
  exportFailedSpans: number;
  redactDroppedSpans: number;
  redactFailedSpans: number;
}

export interface RedactingExporterOptions {
  scrub: ((span: RedactableSpan) => void) | undefined;
  redact: RedactHook | undefined;
  counters: RedactionCounters;
  diagnostics: TelemetryDiagnostics;
}

export interface RedactingExporter extends SpanExporter {
  /**
   * Fails every export still waiting for the inner exporter, and every later one, at once.
   * Called when the shutdown bound expires: the batch processor clears its export timer
   * only when the exporter calls back, and that timer would keep the process alive.
   */
  abort(): void;
}

/** A duck-typed `SpanExporter`; no SDK class is extended or checked with `instanceof`. */
export function createRedactingExporter(
  inner: SpanExporter,
  options: RedactingExporterOptions,
): RedactingExporter {
  const { counters, diagnostics } = options;
  const transforms =
    options.scrub !== undefined || options.redact !== undefined;
  /** Exports handed to the inner exporter and not yet answered, with their span counts. */
  const pending = new Map<(result: ExportResult) => void, number>();
  let aborted = false;
  const abortResult = (): ExportResult => ({
    code: ExportResultCode.FAILED,
    error: new Error("Nestrix telemetry shut down before this export finished"),
  });

  return {
    abort() {
      try {
        aborted = true;
        for (const [done, count] of [...pending]) {
          counters.exportFailedSpans += count;
          done(abortResult());
        }
      } catch (error) {
        diagnostics.countFailure("otel.exporter.abort", error);
      }
    },
    export(spans, resultCallback) {
      let called = false;
      const done = (result: ExportResult): void => {
        if (called) return;
        called = true;
        pending.delete(done);
        try {
          resultCallback(result);
        } catch (error) {
          diagnostics.countFailure("otel.exporter.callback", error);
        }
      };
      if (aborted) {
        counters.exportFailedSpans += spans.length;
        done(abortResult());
        return;
      }
      try {
        const out = transforms ? applyRedaction(spans, options) : spans;
        if (out.length === 0) {
          done({ code: ExportResultCode.SUCCESS });
          return;
        }
        pending.set(done, out.length);
        inner.export(out, (result) => {
          if (called) return;
          try {
            if (result.code === ExportResultCode.SUCCESS) {
              counters.exportedSpans += out.length;
            } else {
              counters.exportFailedSpans += out.length;
            }
          } catch {
            // Counting never stops the callback.
          }
          done(result);
        });
      } catch (error) {
        diagnostics.countFailure("otel.exporter.export", error);
        done({
          code: ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },
    shutdown() {
      return settle(() => inner.shutdown());
    },
    forceFlush() {
      return settle(() => inner.forceFlush?.());
    },
  };
}

function applyRedaction(
  spans: ReadableSpan[],
  options: RedactingExporterOptions,
): ReadableSpan[] {
  const out: ReadableSpan[] = [];
  for (const span of spans) {
    let view: RedactableSpan;
    let keep: unknown;
    try {
      view = toRedactable(span);
      options.scrub?.(view);
      keep = options.redact ? options.redact(view) : undefined;
      if (isThenable(keep)) {
        // An async hook: by the time it settles the span has been exported, so its
        // edits would apply to nothing. Fail closed, and never leave its rejection
        // unhandled (that would end the host process).
        keep.then(undefined, () => undefined);
        options.diagnostics.logOnce(
          "otel.redact.async",
          "The redact hook returned a promise. It must be synchronous; spans it returns a promise for are dropped.",
        );
        throw new Error("redact hook returned a promise");
      }
    } catch (error) {
      // Fail closed: a span whose redaction did not finish is not exported.
      options.counters.redactFailedSpans++;
      options.diagnostics.countFailure("otel.redact", error);
      continue;
    }
    if (keep === false) {
      options.counters.redactDroppedSpans++;
      continue;
    }
    try {
      out.push(fromRedactable(span, view, options.diagnostics));
    } catch (error) {
      options.counters.redactFailedSpans++;
      options.diagnostics.countFailure("otel.redact", error);
    }
  }
  return out;
}

function copyAttributes(attributes: Attributes): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(attributes)) {
    const value = attributes[key];
    copy[key] = Array.isArray(value) ? value.slice() : value;
  }
  return copy;
}

/** A value with a callable `then`. Reading `then` may throw; the caller's catch handles it. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function toRedactable(span: ReadableSpan): RedactableSpan {
  const status: { code: number; message?: string } = {
    code: span.status.code,
  };
  if (span.status.message !== undefined) status.message = span.status.message;
  return {
    name: span.name,
    kind: span.kind,
    status,
    attributes: copyAttributes(span.attributes),
    events: span.events.map((event) => ({
      name: event.name,
      attributes: copyAttributes(event.attributes ?? {}),
    })),
  };
}

function isPrimitive(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isAttributeValue(value: unknown): value is AttributeValue {
  if (isPrimitive(value)) return true;
  return (
    Array.isArray(value) &&
    value.every((v) => v === null || v === undefined || isPrimitive(v))
  );
}

/** Keeps only valid attribute values, so a hook cannot make the serializer throw for the whole batch. */
function toAttributes(
  value: unknown,
  diagnostics: TelemetryDiagnostics,
): Attributes {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "redact hook replaced `attributes` with something that is not an object",
    );
  }
  const attributes: Attributes = {};
  for (const key of Object.keys(value)) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (isAttributeValue(v)) {
      attributes[key] = v;
    } else {
      diagnostics.logOnce(
        "otel.redact.invalid-value",
        `An attribute value left by the redact hook is not a string, number, boolean or array of those; it was removed (first seen: "${key}").`,
      );
    }
  }
  return attributes;
}

function fromRedactable(
  span: ReadableSpan,
  view: RedactableSpan,
  diagnostics: TelemetryDiagnostics,
): ReadableSpan {
  const attributes = toAttributes(view.attributes, diagnostics);
  const events: TimedEvent[] = span.events.map((event, i) => {
    const edited = view.events[i];
    return {
      name: event.name,
      time: event.time,
      droppedAttributesCount: event.droppedAttributesCount,
      attributes: toAttributes(edited?.attributes ?? {}, diagnostics),
    };
  });
  const status = toStatus(view.status);
  const spanContext = span.spanContext();
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => spanContext,
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status,
    attributes,
    links: span.links,
    events,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/** The status the hooks left: `code` must stay 0, 1 or 2; `message` a string or absent. */
function toStatus(value: unknown): SpanStatus {
  if (value === null || typeof value !== "object") {
    throw new Error(
      "redact hook replaced `status` with something that is not an object",
    );
  }
  const { code, message } = value as { code?: unknown; message?: unknown };
  if (code !== 0 && code !== 1 && code !== 2) {
    throw new Error(
      "redact hook set `status.code` to something other than 0, 1 or 2",
    );
  }
  const status: SpanStatus = { code };
  if (typeof message === "string") status.message = message;
  return status;
}

/** Runs `fn` and resolves whatever happens: return, throw or rejection. */
export function settle(fn: () => unknown): Promise<void> {
  try {
    return Promise.resolve(fn()).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}
