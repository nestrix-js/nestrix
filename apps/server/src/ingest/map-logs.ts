/**
 * Maps a decoded `ExportLogsServiceRequest` to the writer's `IngestLogBatch` (P9-07), validating
 * each record on its own: an invalid record is dropped and counted (OTLP partial success), the rest
 * of the request is kept.
 *
 * Logs are kept as context for a trace, not as a log backend (D-19 as amended): a record without a
 * trace id (empty or all zero) is accepted and not kept, and is not counted as rejected (the sender
 * did nothing wrong). Only what the trace view shows is kept: time, severity, the body as text, the
 * `nestrix.log.context` attribute, the span id and the resource (for `service.name`). Other
 * attributes are not stored.
 *
 * Strings are cut and made safe for PostgreSQL (`text` in `map.ts`); the body is then cut to
 * `MAX_LOG_BODY_LENGTH`, as `NestrixLogger` cuts it.
 */
import type { ExportLogsServiceRequest } from "../proto/gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js";
import type { LogRecord } from "../proto/gen/opentelemetry/proto/logs/v1/logs_pb.js";
import { attributes, jsonText, MAX_FUTURE_NS, text } from "./map.js";
import type {
  IngestLogBatch,
  IngestLogRecord,
  IngestResourceLogs,
} from "./model.js";

/** The body is cut to this many UTF-16 units and ends in `…` (as `NestrixLogger`'s cap). */
export const MAX_LOG_BODY_LENGTH = 8192;
/** `severity_text` is cut to this. */
export const MAX_SEVERITY_TEXT_LENGTH = 64;
/** The `nestrix.log.context` attribute is cut to this. */
export const MAX_LOG_CONTEXT_LENGTH = 256;
/** Set by `@nestrix-js/nestjs`'s log export to Nest's logger context. */
export const LOG_CONTEXT_ATTRIBUTE = "nestrix.log.context";

const MAX_INT8 = 2n ** 63n - 1n;

type RejectReason =
  | "invalid trace id"
  | "invalid span id"
  | "missing time"
  | "time out of range"
  | "time more than a day in the future";

function isZero(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b !== 0) return false;
  return true;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "hex",
  );
}

function timeOf(record: LogRecord): bigint {
  return record.timeUnixNano !== 0n
    ? record.timeUnixNano
    : record.observedTimeUnixNano;
}

/** `"none"` for a record without a trace (not kept, not rejected). */
function validate(
  record: LogRecord,
  latest: bigint,
): RejectReason | "none" | undefined {
  const traceId = record.traceId;
  if (traceId.length === 0 || (traceId.length === 16 && isZero(traceId))) {
    return "none";
  }
  if (traceId.length !== 16) return "invalid trace id";
  if (record.spanId.length !== 0 && record.spanId.length !== 8) {
    return "invalid span id";
  }
  const time = timeOf(record);
  if (time === 0n) return "missing time";
  if (time > MAX_INT8) return "time out of range";
  if (time > latest) return "time more than a day in the future";
  return undefined;
}

function bodyText(record: LogRecord): string {
  const body = record.body;
  let out: string;
  if (body === undefined || body.value.case === undefined) out = "";
  else if (body.value.case === "stringValue") out = text(body.value.value);
  else out = jsonText(body);
  return out.length > MAX_LOG_BODY_LENGTH
    ? `${out.slice(0, MAX_LOG_BODY_LENGTH)}…`
    : out;
}

function contextOf(record: LogRecord): string | undefined {
  for (const kv of record.attributes) {
    if (kv.key !== LOG_CONTEXT_ATTRIBUTE) continue;
    const v = kv.value?.value;
    if (v?.case !== "stringValue" || v.value === "") return undefined;
    return text(v.value.slice(0, MAX_LOG_CONTEXT_LENGTH));
  }
  return undefined;
}

function toRecord(record: LogRecord): IngestLogRecord {
  const severity = record.severityNumber as number;
  const out: IngestLogRecord = {
    traceId: hex(record.traceId),
    timeUnixNano: timeOf(record),
    severityNumber:
      Number.isInteger(severity) && severity >= 0 && severity <= 24
        ? severity
        : 0,
    severityText: text(record.severityText.slice(0, MAX_SEVERITY_TEXT_LENGTH)),
    body: bodyText(record),
  };
  if (record.spanId.length === 8 && !isZero(record.spanId)) {
    out.spanId = hex(record.spanId);
  }
  const context = contextOf(record);
  if (context !== undefined) out.context = context;
  return out;
}

export function toIngestLogBatch(
  request: ExportLogsServiceRequest,
  nowUnixNano: bigint = BigInt(Date.now()) * 1_000_000n,
): IngestLogBatch {
  const latest = nowUnixNano + MAX_FUTURE_NS;
  const rejected = new Map<RejectReason, number>();
  const resourceLogs: IngestResourceLogs[] = [];
  let total = 0;

  for (const rl of request.resourceLogs) {
    const records: IngestLogRecord[] = [];
    for (const sl of rl.scopeLogs) {
      for (const record of sl.logRecords) {
        total++;
        const reason = validate(record, latest);
        if (reason === "none") continue;
        if (reason !== undefined) {
          rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
          continue;
        }
        records.push(toRecord(record));
      }
    }
    if (records.length > 0) {
      resourceLogs.push({
        resource: attributes(
          rl.resource?.attributes ?? [],
          rl.resource?.droppedAttributesCount ?? 0,
        ),
        records,
      });
    }
  }

  let rejectedLogRecords = 0;
  for (const n of rejected.values()) rejectedLogRecords += n;
  if (rejectedLogRecords === 0) return { resourceLogs, rejectedLogRecords: 0 };
  const reasons = [...rejected]
    .map(([reason, n]) => `${reason} (${n})`)
    .join(", ");
  return {
    resourceLogs,
    rejectedLogRecords,
    errorMessage: `Rejected ${rejectedLogRecords} of ${total} log records: ${reasons}.`,
  };
}
