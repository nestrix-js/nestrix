/**
 * Decodes an OTLP/HTTP trace request body into the generated `ExportTraceServiceRequest`.
 *
 * Protobuf goes straight through `@bufbuild/protobuf`. OTLP JSON differs from the canonical
 * protobuf JSON mapping only in its ids, which are hex instead of base64 (OTLP specification,
 * "JSON Protobuf Encoding"), so the ids are rewritten to base64 and the rest is decoded by the
 * library's JSON reader: camelCase keys, 64-bit integers as strings or numbers, enums as numbers
 * (names are accepted too), unknown fields ignored. A body that does not decode throws
 * `DecodeError`; the caller answers 400. Invalid ids are not decode errors: they reach the
 * mapper as ids of the wrong length and reject only their span.
 */
import { fromBinary, fromJson, type JsonValue } from "@bufbuild/protobuf";
import {
  type ExportTraceServiceRequest,
  ExportTraceServiceRequestSchema,
} from "../proto/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";

export type BodyFormat = "protobuf" | "json";

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

/** Nesting deeper than this in `AnyValue`s is refused before decoding (stack safety). */
export const MAX_NESTING = 64;

/** A one-byte id: wrong length for any id, so the mapper rejects the span that carries it. */
const INVALID_ID = "AA==";
const HEX = /^(?:[0-9a-fA-F]{2})*$/;

export function decodeRequest(
  body: Buffer,
  format: BodyFormat,
): ExportTraceServiceRequest {
  try {
    if (format === "protobuf") {
      return fromBinary(ExportTraceServiceRequestSchema, body, {
        recursionLimit: MAX_NESTING,
      });
    }
    const json: unknown = JSON.parse(body.toString("utf8"));
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      throw new DecodeError("expected a JSON object");
    }
    rewriteIds(json as Record<string, unknown>);
    return fromJson(ExportTraceServiceRequestSchema, json as JsonValue, {
      ignoreUnknownFields: true,
    });
  } catch (error) {
    if (error instanceof DecodeError) throw error;
    throw new DecodeError(describe(error, format));
  }
}

function describe(error: unknown, format: BodyFormat): string {
  if (error instanceof RangeError) {
    return "request body is nested too deeply";
  }
  if (
    error instanceof TypeError &&
    (error as { code?: unknown }).code === "ERR_ENCODING_INVALID_ENCODED_DATA"
  ) {
    return "request body has a string field that is not valid UTF-8";
  }
  const detail =
    error instanceof Error ? error.message.slice(0, 300) : "unknown error";
  return format === "json"
    ? `request body is not a valid OTLP JSON ExportTraceServiceRequest: ${detail}`
    : `request body is not a valid protobuf ExportTraceServiceRequest: ${detail}`;
}

function hexToBase64(value: unknown): unknown {
  if (typeof value !== "string") return value; // A wrong type fails decoding with a message.
  if (value === "") return value;
  if (!HEX.test(value)) return INVALID_ID;
  return Buffer.from(value, "hex").toString("base64");
}

function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Record<string, unknown> =>
      v !== null && typeof v === "object" && !Array.isArray(v),
  );
}

/** Rewrites hex ids in place. Shapes it does not recognise are left for the decoder to reject. */
function rewriteIds(request: Record<string, unknown>): void {
  for (const rs of objects(request.resourceSpans)) {
    for (const ss of objects(rs.scopeSpans)) {
      for (const span of objects(ss.spans)) {
        if ("traceId" in span) span.traceId = hexToBase64(span.traceId);
        if ("spanId" in span) span.spanId = hexToBase64(span.spanId);
        if ("parentSpanId" in span) {
          span.parentSpanId = hexToBase64(span.parentSpanId);
        }
        for (const link of objects(span.links)) {
          if ("traceId" in link) link.traceId = hexToBase64(link.traceId);
          if ("spanId" in link) link.spanId = hexToBase64(link.spanId);
        }
      }
    }
  }
}
