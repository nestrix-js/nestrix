/**
 * Nestrix's scrub step and the user's `redact` hook, applied to one span (architecture
 * §4.8, D-37). Shared by the export pipeline (`redacting-exporter.ts`, on the batch
 * processor's timer) and the dashboard store (`store/store.ts`, in its drain). Neither
 * caller runs it in a request path.
 *
 * The span is copied into an editable `RedactableSpan`, `scrub` runs, then `redact`, and
 * what the hooks left is validated: attribute values that are not valid OpenTelemetry
 * values are removed (logged once), and a hook that replaced `attributes` or `status`
 * with something unusable fails the span. Callers count and decide what a drop or a
 * failure means; this function does no counting.
 */
import type {
  Attributes,
  AttributeValue,
  SpanStatus,
} from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type { RedactableSpan, RedactHook } from "../options.js";
import type { TelemetryDiagnostics } from "./types.js";

export interface RedactionSteps {
  readonly scrub: ((span: RedactableSpan) => void) | undefined;
  readonly redact: RedactHook | undefined;
  readonly diagnostics: TelemetryDiagnostics;
}

/** What the hooks left, validated. `eventAttributes[i]` belongs to `span.events[i]`. */
export interface RedactedFields {
  readonly outcome: "keep";
  readonly attributes: Attributes;
  readonly eventAttributes: Attributes[];
  readonly status: SpanStatus;
}

export type RedactionResult =
  | RedactedFields
  /** The `redact` hook returned `false`. */
  | { readonly outcome: "drop" }
  /** A step threw, the hook returned a promise, or it left the span unusable. Fail closed. */
  | { readonly outcome: "fail"; readonly error: unknown };

/** Runs `scrub` then `redact` on a copy of `span`. Never throws. */
export function redactSpan(
  span: ReadableSpan,
  steps: RedactionSteps,
): RedactionResult {
  let view: RedactableSpan;
  let keep: unknown;
  try {
    view = toRedactable(span);
    steps.scrub?.(view);
    keep = steps.redact ? steps.redact(view) : undefined;
    if (isThenable(keep)) {
      // An async hook: by the time it settles the span has been exported, so its
      // edits would apply to nothing. Fail closed, and never leave its rejection
      // unhandled (that would end the host process).
      keep.then(undefined, () => undefined);
      steps.diagnostics.logOnce(
        "otel.redact.async",
        "The redact hook returned a promise. It must be synchronous; spans it returns a promise for are dropped.",
      );
      throw new Error("redact hook returned a promise");
    }
  } catch (error) {
    return { outcome: "fail", error };
  }
  if (keep === false) return { outcome: "drop" };
  try {
    const attributes = toAttributes(view.attributes, steps.diagnostics);
    const eventAttributes = span.events.map((_event, i) =>
      toAttributes(view.events[i]?.attributes ?? {}, steps.diagnostics),
    );
    const status = toStatus(view.status);
    return { outcome: "keep", attributes, eventAttributes, status };
  } catch (error) {
    return { outcome: "fail", error };
  }
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

export function isAttributeValue(value: unknown): value is AttributeValue {
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
