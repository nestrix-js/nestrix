/**
 * Maps a decoded `ExportTraceServiceRequest` to the storage writer's `IngestBatch` (`model.ts`),
 * validating each span on its own. An invalid span is dropped and counted; the rest of the
 * request is kept (OTLP partial success).
 *
 * Strings are made safe for PostgreSQL `text` and `jsonb`: lone surrogates become U+FFFD and NUL
 * characters become U+FFFD. Attribute maps are null-prototype objects, so a `__proto__` key is an
 * ordinary key.
 */

import type { ExportTraceServiceRequest } from "../proto/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";
import type {
  AnyValue,
  KeyValue,
} from "../proto/gen/opentelemetry/proto/common/v1/common_pb.js";
import type {
  Span,
  Span_Link,
} from "../proto/gen/opentelemetry/proto/trace/v1/trace_pb.js";
import type {
  IngestAttributeScalar,
  IngestAttributes,
  IngestAttributeValue,
  IngestBatch,
  IngestLink,
  IngestResourceSpans,
  IngestSpan,
  IngestSpanKind,
} from "./model.js";

/** Nesting below this depth in an attribute's JSON text is replaced by `null`. */
const MAX_JSON_DEPTH = 16;

type RejectReason =
  | "invalid trace id"
  | "invalid span id"
  | "invalid parent span id"
  | "missing start time"
  | "end time before start time";

const KINDS: Record<number, IngestSpanKind> = {
  1: "internal",
  2: "server",
  3: "client",
  4: "producer",
  5: "consumer",
};

export function toIngestBatch(request: ExportTraceServiceRequest): IngestBatch {
  const rejected = new Map<RejectReason, number>();
  const resourceSpans: IngestResourceSpans[] = [];
  let total = 0;

  for (const rs of request.resourceSpans) {
    const spans: IngestSpan[] = [];
    for (const ss of rs.scopeSpans) {
      const scope = ss.scope?.name ? safe(ss.scope.name) : undefined;
      for (const span of ss.spans) {
        total++;
        const reason = validate(span);
        if (reason !== undefined) {
          rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
          continue;
        }
        spans.push(toSpan(span, scope));
      }
    }
    if (spans.length > 0) {
      resourceSpans.push({
        resource: attributes(rs.resource?.attributes ?? []),
        spans,
      });
    }
  }

  let rejectedSpans = 0;
  for (const n of rejected.values()) rejectedSpans += n;
  if (rejectedSpans === 0) return { resourceSpans, rejectedSpans: 0 };
  const reasons = [...rejected]
    .map(([reason, n]) => `${reason} (${n})`)
    .join(", ");
  return {
    resourceSpans,
    rejectedSpans,
    errorMessage: `Rejected ${rejectedSpans} of ${total} spans: ${reasons}.`,
  };
}

function isZero(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b !== 0) return false;
  return true;
}

function validId(bytes: Uint8Array, length: number): boolean {
  return bytes.length === length && !isZero(bytes);
}

function validate(span: Span): RejectReason | undefined {
  if (!validId(span.traceId, 16)) return "invalid trace id";
  if (!validId(span.spanId, 8)) return "invalid span id";
  if (span.parentSpanId.length !== 0 && span.parentSpanId.length !== 8) {
    return "invalid parent span id";
  }
  if (span.startTimeUnixNano === 0n) return "missing start time";
  if (span.endTimeUnixNano < span.startTimeUnixNano) {
    return "end time before start time";
  }
  return undefined;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "hex",
  );
}

function toSpan(span: Span, scope: string | undefined): IngestSpan {
  const out: IngestSpan = {
    traceId: hex(span.traceId),
    spanId: hex(span.spanId),
    name: safe(span.name),
    kind: KINDS[span.kind] ?? "internal",
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    attributes: attributes(span.attributes),
    events: span.events.map((e) => ({
      name: safe(e.name),
      timeUnixNano: e.timeUnixNano,
      attributes: attributes(e.attributes),
    })),
    links: links(span.links),
    status: status(span),
  };
  // An all-zero parent id is treated as no parent.
  if (span.parentSpanId.length === 8 && !isZero(span.parentSpanId)) {
    out.parentSpanId = hex(span.parentSpanId);
  }
  if (scope !== undefined) out.scope = scope;
  return out;
}

function links(input: Span_Link[]): IngestLink[] {
  const out: IngestLink[] = [];
  for (const link of input) {
    // A link with an invalid id is dropped; it does not reject its span.
    if (!validId(link.traceId, 16) || !validId(link.spanId, 8)) continue;
    out.push({
      traceId: hex(link.traceId),
      spanId: hex(link.spanId),
      attributes: attributes(link.attributes),
    });
  }
  return out;
}

function status(span: Span): IngestSpan["status"] {
  const code =
    span.status?.code === 1
      ? "ok"
      : span.status?.code === 2
        ? "error"
        : "unset";
  const message = span.status?.message;
  return message ? { code, message: safe(message) } : { code };
}

const LONE_NUL = /\0/g;

/** Well-formed UTF-16 without NUL, which PostgreSQL `text` and `jsonb` reject. */
export function safe(value: string): string {
  const wellFormed = value.isWellFormed() ? value : value.toWellFormed();
  return wellFormed.includes("\0")
    ? wellFormed.replace(LONE_NUL, "�")
    : wellFormed;
}

export function attributes(input: KeyValue[]): IngestAttributes {
  const out: IngestAttributes = Object.create(null);
  for (const kv of input) {
    const value = attributeValue(kv.value);
    if (value !== undefined) out[safe(kv.key)] = value;
  }
  return out;
}

function int(value: bigint): number | string {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

function double(value: number): number | string {
  return Number.isFinite(value) ? value : String(value);
}

function scalar(value: AnyValue): IngestAttributeScalar | undefined {
  switch (value.value.case) {
    case "stringValue":
      return safe(value.value.value);
    case "boolValue":
      return value.value.value;
    case "intValue":
      return int(value.value.value);
    case "doubleValue":
      return double(value.value.value);
    default:
      return undefined;
  }
}

/**
 * Scalars and homogeneous scalar arrays are kept as they are; anything else (kvlists, bytes,
 * mixed or nested arrays) becomes its JSON text. An empty value is dropped.
 */
function attributeValue(
  value: AnyValue | undefined,
): IngestAttributeValue | undefined {
  if (value === undefined || value.value.case === undefined) return undefined;
  const s = scalar(value);
  if (s !== undefined) return s;
  if (value.value.case === "arrayValue") {
    const items = value.value.value.values;
    const scalars: IngestAttributeScalar[] = [];
    let type: string | undefined;
    for (const item of items) {
      const v = scalar(item);
      // Compared after mapping: an int64 beyond 2^53 or a NaN double becomes a string, and
      // an array mixing those with numbers is not homogeneous any more.
      const itemType = typeof v;
      if (v === undefined || (type !== undefined && itemType !== type)) {
        return jsonText(value);
      }
      type = itemType;
      scalars.push(v);
    }
    return scalars;
  }
  return jsonText(value);
}

function jsonText(value: AnyValue): string {
  return JSON.stringify(toJson(value, 0));
}

function toJson(value: AnyValue | undefined, depth: number): unknown {
  if (value === undefined || depth > MAX_JSON_DEPTH) return null;
  const v = value.value;
  switch (v.case) {
    case "stringValue":
      return safe(v.value);
    case "boolValue":
      return v.value;
    case "intValue":
      return int(v.value);
    case "doubleValue":
      return double(v.value);
    case "bytesValue":
      return Buffer.from(v.value).toString("base64");
    case "arrayValue":
      return v.value.values.map((item) => toJson(item, depth + 1));
    case "kvlistValue": {
      const out: Record<string, unknown> = Object.create(null);
      for (const kv of v.value.values) {
        out[safe(kv.key)] = toJson(kv.value, depth + 1);
      }
      return out;
    }
    default:
      return null;
  }
}
