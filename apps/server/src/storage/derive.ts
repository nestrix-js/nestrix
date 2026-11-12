/**
 * Turns the receiver's `IngestSpan`s into rows, and derives the extracted columns.
 *
 * Rules (kept the same as the embedded store, `packages/nestjs/src/store/store.ts`, so both
 * backends answer alike):
 * - error: the span's status code is `error`. An exception event alone (a thrown 4xx) is not.
 * - `http_route` / `http_method`: the string attributes `http.route` / `http.request.method`.
 * - `http_status`: `http.response.status_code`, an integer or an integer string.
 * - trace type of a span as a root (backlog P3-03): `http` for a server span; `job` for a
 *   consumer span or `nestrix.entry = job`; `scheduled` for `nestrix.entry = scheduled`; else
 *   `other`.
 * - `user_id`: the string attribute `user.id`.
 * - route rollup (`route_minutes`): every server span with `http.request.method`, keyed by
 *   method, route (`(unmatched)` without `http.route`) and the minute of its end; an error there
 *   is a status error or a 5xx (the embedded route statistics' definition: 5xx or thrown handler).
 * - class rollup (`class_minutes`): every span with string `nestrix.class` and `nestrix.method`.
 *
 * Postgres cannot store U+0000 in `text` or `jsonb`, and rejects a lone UTF-16 surrogate escaped
 * in JSON; every string (names, attribute keys and values, messages) is made well-formed and its
 * NULs replaced with U+FFFD, so one bad value cannot fail a transaction holding other batches.
 */
import { createHash } from "node:crypto";
import type {
  IngestAttributes,
  IngestAttributeValue,
  IngestSpan,
} from "../ingest/model.js";
import { bucketIndex } from "./histogram.js";
import type { StoredEvent, StoredLink } from "./schema.js";

export const UNKNOWN_SERVICE = "unknown_service";
export const UNMATCHED_ROUTE = "(unmatched)";
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const INT4_MAX = 2_147_483_647;

const CLASS_KINDS = new Set([
  "controller",
  "service",
  "repository",
  "processor",
  "provider",
  "guard",
  "pipe",
  "interceptor",
  "filter",
]);

export type TraceType = "http" | "job" | "scheduled" | "other";

/** A string Postgres accepts in `text` and in `jsonb`. */
export function cleanString(value: string): string {
  const wellFormed = value.isWellFormed() ? value : value.toWellFormed();
  return wellFormed.includes("\u0000")
    ? wellFormed.replaceAll("\u0000", "�")
    : wellFormed;
}

function cleanValue(value: IngestAttributeValue): IngestAttributeValue {
  if (typeof value === "string") return cleanString(value);
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === "string" ? cleanString(v) : v));
  }
  return value;
}

export function cleanAttributes(
  attributes: IngestAttributes | undefined,
): IngestAttributes {
  const out: IngestAttributes = {};
  if (attributes === null || typeof attributes !== "object") return out;
  for (const key of Object.keys(attributes)) {
    const value = attributes[key];
    if (value === undefined || value === null) continue;
    out[cleanString(key)] = cleanValue(value);
  }
  return out;
}

/** JSON with keys sorted at every level, for hashing. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface ResourceRow {
  hash: string;
  serviceName: string;
  serviceVersion: string | null;
  attributes: IngestAttributes;
}

export function deriveResource(
  resource: IngestAttributes | undefined,
): ResourceRow {
  const attributes = cleanAttributes(resource);
  const name = attributes["service.name"];
  const version = attributes["service.version"];
  return {
    hash: createHash("sha256").update(canonicalJson(attributes)).digest("hex"),
    serviceName:
      typeof name === "string" && name !== "" ? name : UNKNOWN_SERVICE,
    serviceVersion:
      typeof version === "string" && version !== "" ? version : null,
    attributes,
  };
}

/** Unix ns to an ISO timestamp with microseconds. */
export function nsToIso(ns: bigint): string {
  const ms = ns / 1_000_000n;
  const micros = (ns / 1_000n) % 1_000n;
  const iso = new Date(Number(ms)).toISOString(); // ....sssZ
  return `${iso.slice(0, -1)}${micros.toString().padStart(3, "0")}Z`;
}

/**
 * Latest Unix ns that fits PostgreSQL `int8` (2^63 - 1, about the year 2262). Its millisecond
 * value is also a valid JS Date (whose limit, 8.64e15 ms, is 8.64e21 ns: far larger).
 */
export const MAX_NS = 9_223_372_036_854_775_807n;

function stringAttr(a: IngestAttributes, key: string): string | null {
  const v = a[key];
  return typeof v === "string" && v !== "" ? v : null;
}

export function statusCodeOf(a: IngestAttributes): number | null {
  const v = a["http.response.status_code"];
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && v !== ""
        ? Number(v)
        : Number.NaN;
  return Number.isInteger(n) && n >= 0 && n <= INT4_MAX ? n : null;
}

export function traceTypeOf(
  kind: IngestSpan["kind"],
  a: IngestAttributes,
): TraceType {
  if (kind === "server") return "http";
  const entry = a["nestrix.entry"];
  if (kind === "consumer" || entry === "job") return "job";
  if (entry === "scheduled") return "scheduled";
  return "other";
}

export interface SpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  resourceHash: string;
  serviceName: string;
  /** `service.version` of the span's resource (the trace's release when the span is its root). */
  release: string | null;
  name: string;
  kind: IngestSpan["kind"];
  startTime: string;
  startNs: bigint;
  endNs: bigint;
  durationNs: bigint;
  durationMs: number;
  /** UTC day (days since the epoch) of the start: the span's partition. */
  startDay: number;
  /** Unix ms of the minute holding the span's end: its rollup minute. */
  endMinuteMs: number;
  statusCode: "unset" | "ok" | "error";
  statusMessage: string | null;
  scope: string | null;
  attributesJson: string;
  eventsJson: string;
  linksJson: string;
  httpRoute: string | null;
  httpMethod: string | null;
  httpStatus: number | null;
  isRoot: boolean;
  isError: boolean;
  traceType: TraceType;
  /** A consumer span or `nestrix.entry = 'job'`: marks its trace `has_job`, whatever the root. */
  isJob: boolean;
  userId: string | null;
  className: string | null;
  methodName: string | null;
  classKind: string;
  /** Counted in `route_minutes`. */
  isRouteSpan: boolean;
  /** Error for the route rollup: status error or 5xx. */
  isRouteError: boolean;
}

/** A row, or `null` when the span's times cannot be stored (the receiver checks them first). */
export function deriveSpan(
  span: IngestSpan,
  resource: ResourceRow,
): SpanRow | null {
  const startNs = span.startTimeUnixNano;
  const endNs = span.endTimeUnixNano;
  if (
    typeof startNs !== "bigint" ||
    typeof endNs !== "bigint" ||
    startNs < 0n ||
    endNs < startNs ||
    endNs > MAX_NS
  ) {
    return null;
  }
  const attributes = cleanAttributes(span.attributes);
  const durationNs = endNs - startNs;
  const durationMs = Number(durationNs) / 1e6;
  const startMs = Number(startNs / 1_000_000n);
  const endMs = Number(endNs / 1_000_000n);
  const statusCode = span.status?.code ?? "unset";
  const isError = statusCode === "error";
  const httpMethod = stringAttr(attributes, "http.request.method");
  const httpStatus = statusCodeOf(attributes);
  const className = stringAttr(attributes, "nestrix.class");
  const methodName = stringAttr(attributes, "nestrix.method");
  const component = stringAttr(attributes, "nestrix.component");
  const events: StoredEvent[] = (span.events ?? []).map((e) => ({
    name: cleanString(String(e.name)),
    timeUnixNano: String(e.timeUnixNano),
    attributes: cleanAttributes(e.attributes),
  }));
  const links: StoredLink[] = (span.links ?? []).map((l) => ({
    traceId: cleanString(String(l.traceId)),
    spanId: cleanString(String(l.spanId)),
    attributes: cleanAttributes(l.attributes),
  }));
  const parentSpanId =
    typeof span.parentSpanId === "string" && span.parentSpanId !== ""
      ? cleanString(span.parentSpanId)
      : null;
  return {
    traceId: cleanString(span.traceId),
    spanId: cleanString(span.spanId),
    parentSpanId,
    resourceHash: resource.hash,
    serviceName: resource.serviceName,
    release: resource.serviceVersion,
    name: cleanString(String(span.name)),
    kind: span.kind,
    startTime: nsToIso(startNs),
    startNs,
    endNs,
    durationNs,
    durationMs,
    startDay: Math.floor(startMs / DAY_MS),
    endMinuteMs: Math.floor(endMs / MINUTE_MS) * MINUTE_MS,
    statusCode,
    statusMessage:
      typeof span.status?.message === "string" && span.status.message !== ""
        ? cleanString(span.status.message)
        : null,
    scope:
      typeof span.scope === "string" && span.scope !== ""
        ? cleanString(span.scope)
        : null,
    attributesJson: JSON.stringify(attributes),
    eventsJson: JSON.stringify(events),
    linksJson: JSON.stringify(links),
    httpRoute: stringAttr(attributes, "http.route"),
    httpMethod,
    httpStatus,
    isRoot: parentSpanId === null,
    isError,
    traceType: traceTypeOf(span.kind, attributes),
    isJob: span.kind === "consumer" || attributes["nestrix.entry"] === "job",
    userId: stringAttr(attributes, "user.id"),
    className,
    methodName,
    classKind:
      component !== null && CLASS_KINDS.has(component) ? component : "provider",
    isRouteSpan: span.kind === "server" && httpMethod !== null,
    isRouteError: isError || (httpStatus !== null && httpStatus >= 500),
  };
}

/** Rollup key and bucket helpers. */
export function minuteDay(minuteMs: number): number {
  return Math.floor(minuteMs / DAY_MS);
}

export function histogramBucket(durationMs: number): number {
  return bucketIndex(durationMs);
}
