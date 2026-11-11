/**
 * Copies an ended SDK span into a `SpanRecord` (the query API's shape) and estimates
 * what the copy costs in memory. Runs in the store's drain, never in `onEnd`.
 *
 * The span may come from any copy of the SDK (a CommonJS host's `.cjs` build, the
 * host's own instrumentation) or be malformed, so it is read structurally and every
 * field is checked: a span without a usable trace id, span id or times throws, and the
 * caller counts it. No `instanceof` on OpenTelemetry classes (architecture §4.5).
 *
 * Byte estimate. `JSON.stringify` per span would allocate the whole serialized span
 * again only to measure it (and under-states the heap: about 550 bytes of JSON per span
 * against about 680 bytes of heap in the calibration below). Instead the copy is costed
 * while it is built, from a few V8 constants: an object header plus a slot per property,
 * a heap string's header plus one byte per character (two when it has a char above U+00FF), 16 bytes per heap number.
 * Attribute keys are not counted: instrumentations use shared constant strings, so a key
 * costs a slot, not a copy. A dynamic key (a fresh string per span) is under-counted; the per-object constants absorb that for typical spans.
 * Calibrated against `process.memoryUsage().heapUsed` after a forced GC, with realistic
 * four-span traces through a real SDK 3 provider (darwin-arm64, Node 26.13): the
 * estimate is 1.14x to 1.22x the heap growth, Latin-1 and two-byte values, 2,200 to
 * 10,200 traces. `store-bytes.test.ts` keeps it within a band.
 */
import type { RedactedFields } from "../otel/redaction.js";
import { isAttributeValue } from "../otel/redaction.js";
import type {
  Attributes,
  AttributeValue,
  SpanEvent,
  SpanKind,
  SpanLink,
  SpanRecord,
  StatusCode,
} from "./protocol-types.js";

/** An object's header (map, properties, elements) plus its in-object slots, roughly. */
const OBJECT_BYTES = 32;
/** One property: a slot, plus its share of a dictionary-mode backing store. */
const PROPERTY_BYTES = 16;
/** A sequential heap string's header; one byte per character is added. */
const STRING_BYTES = 16;
const NUMBER_BYTES = 16;
const ARRAY_BYTES = 16;
/** The record object (11 properties), its status object and its wrapper in the store. */
const SPAN_BYTES = 200;
/** A stored trace: its entry, span array and map slot. */
export const TRACE_BYTES = 320;
/** One error-list item. */
export const ERROR_ITEM_BYTES = 96;

export function stringBytes(value: string): number {
  // V8 keeps a string with any char above U+00FF as two bytes per character.
  return STRING_BYTES + (/[\u0100-\uffff]/.test(value) ? 2 : 1) * value.length;
}

function valueBytes(value: AttributeValue): number {
  if (typeof value === "string") return stringBytes(value);
  if (typeof value === "number") return NUMBER_BYTES;
  if (typeof value === "boolean") return 0;
  let bytes = ARRAY_BYTES + 8 * value.length;
  for (const item of value) {
    if (typeof item === "string") bytes += stringBytes(item);
    else if (typeof item === "number") bytes += NUMBER_BYTES;
  }
  return bytes;
}

export function attributesBytes(attributes: Attributes): number {
  let bytes = OBJECT_BYTES;
  for (const key of Object.keys(attributes)) {
    const value = attributes[key];
    if (value === undefined) continue;
    bytes += PROPERTY_BYTES + valueBytes(value);
  }
  return bytes;
}

const KINDS: readonly SpanKind[] = [
  "internal",
  "server",
  "client",
  "producer",
  "consumer",
];
const STATUS: readonly StatusCode[] = ["unset", "ok", "error"];

/** Exactly `length` lowercase hex digits. A loop: cheaper per span than a regex test. */
function isLowerHex(value: string, length: number): boolean {
  if (value.length !== length) return false;
  for (let i = 0; i < length; i++) {
    const c = value.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

/** `[seconds, nanoseconds]` to fractional milliseconds. */
function hrToMs(value: unknown, what: string): number {
  if (
    Array.isArray(value) &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  ) {
    const ms = value[0] * 1000 + value[1] / 1e6;
    if (Number.isFinite(ms)) return ms;
  }
  throw new Error(`span ${what} is not an HrTime`);
}

/** A copy holding only valid attribute values (arrays copied, nulls in arrays dropped). */
function copyValidAttributes(source: unknown): Attributes {
  const out: Attributes = {};
  if (source === null || typeof source !== "object") return out;
  for (const key of Object.keys(source)) {
    const value = (source as Record<string, unknown>)[key];
    if (value === undefined || !isAttributeValue(value)) continue;
    out[key] = Array.isArray(value)
      ? (value.filter((v) => v !== null && v !== undefined) as AttributeValue)
      : (value as AttributeValue);
  }
  return out;
}

/** The identity of a span, read before anything else so a malformed one fails early. */
export interface SpanIdentity {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  /** No parent, or a parent in another process: a candidate for the trace's local root. */
  readonly localRoot: boolean;
}

export function readIdentity(span: unknown): SpanIdentity {
  const s = span as {
    spanContext?: () => { traceId?: unknown; spanId?: unknown };
    parentSpanContext?: { spanId?: unknown; isRemote?: unknown };
  };
  const context = s.spanContext?.();
  const traceId = context?.traceId;
  const spanId = context?.spanId;
  if (typeof traceId !== "string" || !isLowerHex(traceId, 32)) {
    throw new Error("span has no valid trace id");
  }
  if (typeof spanId !== "string" || !isLowerHex(spanId, 16)) {
    throw new Error("span has no valid span id");
  }
  const parent = s.parentSpanContext;
  const parentId = parent?.spanId;
  const parentSpanId =
    typeof parentId === "string" && isLowerHex(parentId, 16)
      ? parentId
      : undefined;
  return {
    traceId,
    spanId,
    parentSpanId,
    localRoot: parentSpanId === undefined || parent?.isRemote === true,
  };
}

/**
 * `redactSpan` output is Nestrix's own copy and may keep `null`/`undefined` inside
 * arrays (the API's `AttributeValue` allows them; the query API's does not). Removes
 * them in place and returns what {@link attributesBytes} returns for the result, in one
 * pass over the keys (P2-15: it was two passes and two key arrays per attributes object).
 */
function cleanAndMeasure(attributes: Record<string, unknown>): number {
  let bytes = OBJECT_BYTES;
  for (const key of Object.keys(attributes)) {
    let value = attributes[key];
    if (
      Array.isArray(value) &&
      value.some((v) => v === null || v === undefined)
    ) {
      value = value.filter((v) => v !== null && v !== undefined);
      attributes[key] = value;
    }
    if (value === undefined) continue;
    bytes += PROPERTY_BYTES + valueBytes(value as AttributeValue);
  }
  return bytes;
}

export interface BuiltRecord {
  readonly record: SpanRecord;
  readonly bytes: number;
}

/**
 * Builds the record from the span's own fields and the redacted fields (attributes,
 * event attributes, status) that `redactSpan` left. Throws on a malformed span.
 */
export function buildRecord(
  span: unknown,
  identity: SpanIdentity,
  fields: RedactedFields,
): BuiltRecord {
  const s = span as {
    name?: unknown;
    kind?: unknown;
    startTime?: unknown;
    duration?: unknown;
    events?: unknown;
    links?: unknown;
    instrumentationScope?: { name?: unknown };
  };
  const name = typeof s.name === "string" ? s.name : String(s.name);
  const kind = (typeof s.kind === "number" && KINDS[s.kind]) || "internal";
  const startTimeUnixMs = hrToMs(s.startTime, "start time");
  const durationMs = hrToMs(s.duration, "duration");
  const spanAttributes = fields.attributes as Attributes;
  let bytes =
    SPAN_BYTES +
    stringBytes(identity.spanId) +
    stringBytes(name) +
    cleanAndMeasure(spanAttributes);
  if (identity.parentSpanId !== undefined) {
    bytes += stringBytes(identity.parentSpanId);
  }

  const events: SpanEvent[] = [];
  const sourceEvents = Array.isArray(s.events) ? s.events : [];
  sourceEvents.forEach((event: { name?: unknown; time?: unknown }, i) => {
    const eventName =
      typeof event?.name === "string" ? event.name : String(event?.name);
    const attributes = (fields.eventAttributes[i] ?? {}) as Attributes;
    const attributesCost = cleanAndMeasure(attributes);
    events.push({
      name: eventName,
      timeUnixMs: hrToMs(event?.time, "event time"),
      attributes,
    });
    bytes +=
      OBJECT_BYTES +
      3 * PROPERTY_BYTES +
      NUMBER_BYTES +
      stringBytes(eventName) +
      attributesCost;
  });
  bytes += ARRAY_BYTES + 8 * events.length;

  const links: SpanLink[] = [];
  if (Array.isArray(s.links)) {
    for (const link of s.links as {
      context?: { traceId?: unknown; spanId?: unknown };
    }[]) {
      const traceId = link?.context?.traceId;
      const spanId = link?.context?.spanId;
      if (typeof traceId !== "string" || typeof spanId !== "string") continue;
      links.push({ traceId, spanId });
      bytes +=
        OBJECT_BYTES +
        2 * PROPERTY_BYTES +
        stringBytes(traceId) +
        stringBytes(spanId);
    }
  }
  bytes += ARRAY_BYTES + 8 * links.length;

  const status: SpanRecord["status"] = {
    code: STATUS[fields.status.code] ?? "unset",
  };
  if (typeof fields.status.message === "string") {
    status.message = fields.status.message;
    bytes += stringBytes(status.message);
  }

  const record: SpanRecord = {
    spanId: identity.spanId,
    name,
    kind,
    startTimeUnixMs,
    durationMs,
    attributes: spanAttributes,
    events,
    status,
    links,
  };
  if (identity.parentSpanId !== undefined) {
    record.parentSpanId = identity.parentSpanId;
  }
  const scope = s.instrumentationScope?.name;
  if (typeof scope === "string" && scope !== "") {
    record.scope = scope;
    bytes += stringBytes(scope);
  }
  return { record, bytes };
}

/** The span's resource attributes, copied (valid values only). Never throws. */
export function readResource(span: unknown): {
  attributes: Attributes;
  bytes: number;
} {
  try {
    const attributes = copyValidAttributes(
      (span as { resource?: { attributes?: unknown } }).resource?.attributes,
    );
    return { attributes, bytes: attributesBytes(attributes) };
  } catch {
    return { attributes: {}, bytes: OBJECT_BYTES };
  }
}
