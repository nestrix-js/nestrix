/**
 * Guards against decoded-object amplification: a small body that decodes into a huge object
 * graph (64 MiB of empty spans, `0x12 0x00` repeated, gzips to ~65 KB and decoded to gigabytes).
 * Both checks run on the raw bytes before the decoder allocates anything.
 *
 * - Protobuf: a walk of the wire format, driven by the generated descriptors, that counts every
 *   submessage (and every element of a repeated string or bytes field) and every span, without
 *   decoding. Unknown fields are not counted because the decoder is told to skip them.
 * - JSON: a count of the bytes `{`, `[` and `,`, which bounds the values `JSON.parse` creates
 *   (each value is a container or follows a comma) and the messages the JSON reader builds.
 */
import type { DescField, DescMessage } from "@bufbuild/protobuf";
import { ExportLogsServiceRequestSchema } from "../proto/gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js";
import { ExportTraceServiceRequestSchema } from "../proto/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";
import { LogRecordSchema } from "../proto/gen/opentelemetry/proto/logs/v1/logs_pb.js";
import { SpanSchema } from "../proto/gen/opentelemetry/proto/trace/v1/trace_pb.js";

/** The request message of a signal and the item counted against `maxSpans`. */
export interface WireShape {
  readonly root: DescMessage;
  readonly item: DescMessage;
  /** Plural, for messages: `spans`, `log records`. */
  readonly items: string;
}

export const TRACE_SHAPE: WireShape = {
  root: ExportTraceServiceRequestSchema,
  item: SpanSchema,
  items: "spans",
};

/** `POST /v1/logs` (P9-07): the same walk, counting log records. */
export const LOG_SHAPE: WireShape = {
  root: ExportLogsServiceRequestSchema,
  item: LogRecordSchema,
  items: "log records",
};

export interface DecodeLimits {
  /** Spans per request (log records, for a log export). */
  readonly maxSpans: number;
  /** Submessages per protobuf request; `{` per JSON request. */
  readonly maxMessages: number;
  /** `{`, `[` and `,` per JSON request. */
  readonly maxJsonTokens: number;
  /** Message nesting depth. */
  readonly maxDepth: number;
}

/** The request is within the size limit but would decode into too much. Answered 413. */
export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitError";
  }
}

/** The wire format is broken. Answered 400. */
export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireError";
  }
}

/** Per message type: field number → the field, for length-delimited fields that allocate. */
const tables = new WeakMap<DescMessage, Map<number, DescField>>();
function table(desc: DescMessage): Map<number, DescField> {
  let t = tables.get(desc);
  if (t === undefined) {
    t = new Map(desc.fields.map((f) => [f.number, f]));
    tables.set(desc, t);
  }
  return t;
}

function childMessage(field: DescField | undefined): DescMessage | undefined {
  if (field === undefined) return undefined;
  if (field.fieldKind === "message") return field.message;
  if (field.fieldKind === "list" && field.listKind === "message") {
    return field.message;
  }
  return undefined;
}

function repeatedElement(field: DescField | undefined): boolean {
  return (
    field !== undefined &&
    field.fieldKind === "list" &&
    field.listKind === "scalar"
  );
}

interface Frame {
  desc: DescMessage;
  end: number;
}

/** What a body will decode into, for charging the in-flight budget. */
export interface DecodeCost {
  /** Messages (protobuf) or objects (JSON). */
  messages: number;
  /** Spans (protobuf only; JSON spans are counted after parsing). */
  spans: number;
  /** JSON arrays and commas (0 for protobuf). */
  otherTokens: number;
}

/**
 * Walks an export request (`ExportTraceServiceRequest` by default) without decoding it. Throws
 * `LimitError` or `WireError`.
 */
export function checkProtobuf(
  buf: Uint8Array,
  limits: DecodeLimits,
  shape: WireShape = TRACE_SHAPE,
): DecodeCost {
  let pos = 0;
  let messages = 0;
  let spans = 0;
  const stack: Frame[] = [];
  let frame: Frame = { desc: shape.root, end: buf.length };

  const varint = (): number => {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (pos >= frame.end) throw new WireError("truncated varint");
      const byte = buf[pos++];
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return result;
      scale *= 128;
    }
    throw new WireError("varint longer than 10 bytes");
  };

  for (;;) {
    if (pos === frame.end) {
      const parent = stack.pop();
      if (parent === undefined) return { messages, spans, otherTokens: 0 };
      frame = parent;
      continue;
    }
    const tag = varint();
    const wireType = tag % 8;
    const fieldNo = Math.floor(tag / 8);
    switch (wireType) {
      case 0:
        varint();
        break;
      case 1:
        pos += 8;
        break;
      case 5:
        pos += 4;
        break;
      case 2: {
        const length = varint();
        const start = pos;
        const end = start + length;
        if (end > frame.end) throw new WireError("length past the end");
        const field = table(frame.desc).get(fieldNo);
        const child = childMessage(field);
        if (child !== undefined) {
          if (++messages > limits.maxMessages) {
            throw new LimitError(
              `request has more than ${limits.maxMessages} protobuf messages`,
            );
          }
          if (child === shape.item && ++spans > limits.maxSpans) {
            throw new LimitError(
              `request has more than ${limits.maxSpans} ${shape.items}`,
            );
          }
          if (stack.length + 1 >= limits.maxDepth) {
            throw new WireError("request body is nested too deeply");
          }
          stack.push(frame);
          frame = { desc: child, end };
          continue; // pos stays at the child's first byte
        }
        if (repeatedElement(field) && ++messages > limits.maxMessages) {
          throw new LimitError(
            `request has more than ${limits.maxMessages} protobuf messages`,
          );
        }
        pos = end;
        break;
      }
      default:
        throw new WireError(`unsupported wire type ${wireType}`);
    }
    if (pos > frame.end) throw new WireError("field past the end");
  }
}

/** Bounds what `JSON.parse` and the JSON reader would build. Throws `LimitError`. */
export function checkJson(buf: Uint8Array, limits: DecodeLimits): DecodeCost {
  let braces = 0;
  let tokens = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x7b) {
      braces++;
      tokens++;
    } else if (b === 0x5b || b === 0x2c) {
      tokens++;
    }
  }
  if (braces > limits.maxMessages) {
    throw new LimitError(
      `request has more than ${limits.maxMessages} JSON objects`,
    );
  }
  if (tokens > limits.maxJsonTokens) {
    throw new LimitError(
      `request has more than ${limits.maxJsonTokens} JSON values`,
    );
  }
  return { messages: braces, spans: 0, otherTokens: tokens - braces };
}

/** Bytes charged per decoded message or span (measured: ~115-345 B for protobuf-es plus the mapped copy). */
export const BYTES_PER_MESSAGE = 512;
/** Bytes charged per JSON array or comma-separated value (measured: ~40 B). */
export const BYTES_PER_JSON_TOKEN = 48;

export function decodeCharge(cost: DecodeCost): number {
  return (
    (cost.messages + cost.spans) * BYTES_PER_MESSAGE +
    cost.otherTokens * BYTES_PER_JSON_TOKEN
  );
}

/**
 * Process-wide budget for request body bytes held in memory at once (compressed bytes read plus
 * inflated bytes buffered). A request that would overflow it is answered 503 with Retry-After.
 */
export class ByteBudget {
  private used = 0;
  constructor(readonly capacity: number) {}
  get inUse(): number {
    return this.used;
  }
  tryTake(bytes: number): boolean {
    if (this.used + bytes > this.capacity) return false;
    this.used += bytes;
    return true;
  }
  release(bytes: number): void {
    this.used = Math.max(0, this.used - bytes);
  }
}
