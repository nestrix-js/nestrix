/**
 * Decodes an OTLP/HTTP trace request body into the generated `ExportTraceServiceRequest`.
 *
 * `checkBody` runs first, on the raw bytes, and bounds what decoding will allocate (`limits.ts`).
 * Protobuf then goes through `@bufbuild/protobuf`, skipping unknown fields (each would otherwise
 * be kept as an object). OTLP JSON differs from the canonical protobuf JSON mapping only in its
 * ids, which are hex instead of base64 (OTLP specification, "JSON Protobuf Encoding"), so the ids
 * are rewritten to base64 and the rest is decoded by the library's JSON reader: camelCase keys,
 * 64-bit integers as strings or numbers, enums as numbers (names are accepted too), unknown
 * fields ignored. A body that does not decode throws `DecodeError` (400); one over a limit throws
 * `LimitError` (413). Invalid ids are not decode errors: they reach the mapper as ids of the
 * wrong length and reject only their span.
 */
import { fromBinary, fromJson, type JsonValue } from "@bufbuild/protobuf";
import {
  type ExportLogsServiceRequest,
  ExportLogsServiceRequestSchema,
} from "../proto/gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js";
import {
  type ExportMetricsServiceRequest,
  ExportMetricsServiceRequestSchema,
} from "../proto/gen/opentelemetry/proto/collector/metrics/v1/metrics_service_pb.js";
import {
  type ExportTraceServiceRequest,
  ExportTraceServiceRequestSchema,
} from "../proto/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";
import {
  checkJson,
  checkProtobuf,
  type DecodeCost,
  type DecodeLimits,
  LimitError,
  TRACE_SHAPE,
  WireError,
  type WireShape,
} from "./limits.js";

export type BodyFormat = "protobuf" | "json";

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

/** A one-byte id: wrong length for any id, so the mapper rejects the span that carries it. */
const INVALID_ID = "AA==";
const HEX = /^(?:[0-9a-fA-F]{2})*$/;

/** Bounds the decoding cost before anything is allocated. Throws `LimitError` or `DecodeError`. */
export function checkBody(
  body: Uint8Array,
  format: BodyFormat,
  limits: DecodeLimits,
  shape: WireShape = TRACE_SHAPE,
): DecodeCost {
  try {
    return format === "protobuf"
      ? checkProtobuf(body, limits, shape)
      : checkJson(body, limits);
  } catch (error) {
    if (error instanceof WireError) {
      throw new DecodeError(
        `request body is not a valid protobuf ${shape.root.name}: ${error.message}`,
      );
    }
    throw error;
  }
}

export function decodeRequest(
  body: Buffer,
  format: BodyFormat,
  limits: DecodeLimits,
): ExportTraceServiceRequest {
  try {
    if (format === "protobuf") {
      return fromBinary(ExportTraceServiceRequestSchema, body, {
        recursionLimit: limits.maxDepth,
        readUnknownFields: false,
      });
    }
    const json: unknown = JSON.parse(body.toString("utf8"));
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      throw new DecodeError("expected a JSON object");
    }
    const spans = rewriteIds(json as Record<string, unknown>);
    if (spans > limits.maxSpans) {
      throw new LimitError(`request has more than ${limits.maxSpans} spans`);
    }
    return fromJson(ExportTraceServiceRequestSchema, json as JsonValue, {
      ignoreUnknownFields: true,
    });
  } catch (error) {
    if (error instanceof DecodeError || error instanceof LimitError) {
      throw error;
    }
    throw new DecodeError(describe(error, format));
  }
}

/**
 * `decodeRequest` for `POST /v1/logs` (P9-07): the same rules, over `ExportLogsServiceRequest`.
 * Run `checkBody(…, LOG_SHAPE)` first.
 */
export function decodeLogsRequest(
  body: Buffer,
  format: BodyFormat,
  limits: DecodeLimits,
): ExportLogsServiceRequest {
  try {
    if (format === "protobuf") {
      return fromBinary(ExportLogsServiceRequestSchema, body, {
        recursionLimit: limits.maxDepth,
        readUnknownFields: false,
      });
    }
    const json: unknown = JSON.parse(body.toString("utf8"));
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      throw new DecodeError("expected a JSON object");
    }
    const records = rewriteLogIds(json as Record<string, unknown>);
    if (records > limits.maxSpans) {
      throw new LimitError(
        `request has more than ${limits.maxSpans} log records`,
      );
    }
    return fromJson(ExportLogsServiceRequestSchema, json as JsonValue, {
      ignoreUnknownFields: true,
    });
  } catch (error) {
    if (error instanceof DecodeError || error instanceof LimitError) {
      throw error;
    }
    throw new DecodeError(describe(error, format, "ExportLogsServiceRequest"));
  }
}

/**
 * `decodeRequest` for `POST /v1/metrics` (issue #18, D-105): the same rules, over
 * `ExportMetricsServiceRequest`. Run `checkBody(…, METRIC_SHAPE)` first. In JSON, exemplars (whose
 * ids are hex) are removed before decoding: nothing reads them.
 */
export function decodeMetricsRequest(
  body: Buffer,
  format: BodyFormat,
  limits: DecodeLimits,
): ExportMetricsServiceRequest {
  try {
    if (format === "protobuf") {
      return fromBinary(ExportMetricsServiceRequestSchema, body, {
        recursionLimit: limits.maxDepth,
        readUnknownFields: false,
      });
    }
    const json: unknown = JSON.parse(body.toString("utf8"));
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      throw new DecodeError("expected a JSON object");
    }
    const points = dropExemplars(json as Record<string, unknown>);
    if (points > limits.maxSpans) {
      throw new LimitError(
        `request has more than ${limits.maxSpans} data points`,
      );
    }
    return fromJson(ExportMetricsServiceRequestSchema, json as JsonValue, {
      ignoreUnknownFields: true,
    });
  } catch (error) {
    if (error instanceof DecodeError || error instanceof LimitError) {
      throw error;
    }
    throw new DecodeError(
      describe(error, format, "ExportMetricsServiceRequest"),
    );
  }
}

const METRIC_DATA_FIELDS = [
  "gauge",
  "sum",
  "histogram",
  "exponentialHistogram",
  "summary",
] as const;

/** A JSON field by its camelCase name or, failing that, its snake_case spelling (protobuf JSON accepts both). */
function field(o: Record<string, unknown>, camel: string): unknown {
  if (Object.hasOwn(o, camel)) return o[camel];
  return o[camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
}

/** Removes `exemplars` from every data point in place; returns the data point count. */
function dropExemplars(request: Record<string, unknown>): number {
  let points = 0;
  for (const rm of objects(field(request, "resourceMetrics"))) {
    for (const sm of objects(field(rm, "scopeMetrics"))) {
      for (const metric of objects(sm.metrics)) {
        for (const kind of METRIC_DATA_FIELDS) {
          const data =
            metric[kind] ??
            metric[kind.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
          if (data === null || typeof data !== "object") continue;
          for (const point of objects(
            field(data as Record<string, unknown>, "dataPoints"),
          )) {
            points++;
            delete point.exemplars;
          }
        }
      }
    }
  }
  return points;
}

function describe(
  error: unknown,
  format: BodyFormat,
  name = "ExportTraceServiceRequest",
): string {
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
    ? `request body is not a valid OTLP JSON ${name}: ${detail}`
    : `request body is not a valid protobuf ${name}: ${detail}`;
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

/**
 * Rewrites hex ids in place and returns the number of span objects. Shapes it does not
 * recognise are left for the decoder to reject.
 */
function rewriteIds(request: Record<string, unknown>): number {
  let spans = 0;
  for (const rs of objects(field(request, "resourceSpans"))) {
    for (const ss of objects(field(rs, "scopeSpans"))) {
      for (const span of objects(ss.spans)) {
        spans++;
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
  return spans;
}

/** `rewriteIds` for a log export: hex `traceId` and `spanId` of each record; returns the record count. */
function rewriteLogIds(request: Record<string, unknown>): number {
  let records = 0;
  for (const rl of objects(request.resourceLogs)) {
    for (const sl of objects(rl.scopeLogs)) {
      for (const record of objects(sl.logRecords)) {
        records++;
        if ("traceId" in record) record.traceId = hexToBase64(record.traceId);
        if ("spanId" in record) record.spanId = hexToBase64(record.spanId);
      }
    }
  }
  return records;
}
