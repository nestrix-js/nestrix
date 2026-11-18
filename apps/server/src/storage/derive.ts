/**
 * Turns the receiver's `IngestSpan`s into rows, and derives the extracted columns.
 *
 * Rules (kept the same as the embedded store, `packages/nestjs/src/store/store.ts`, so both
 * backends answer alike):
 * - error: the span's status code is `error`. An exception event alone (a thrown 4xx) is not.
 * - failed (`isFailure`, the trace's `has_errors`, D-94): status `error`, unless every exception
 *   event on the span is marked `nestrix.exception.expected` (`error-facts.ts`).
 * - `is_occurrence` / `error_key` (D-93): `isErrorOccurrence`, and for an error span with a
 *   primary exception a SHA-256 of its type, message and stack trace (hex, first 32 characters),
 *   which the query's legacy parent rule compares (`query/error-sql.ts`).
 * - `http_route` / `http_method`: the string attributes `http.route` / `http.request.method`.
 * - `http_status`: `http.response.status_code`, an integer or an integer string.
 * - trace type of a span as a root (backlog P3-03): `http` for a server span; `job` for a
 *   consumer span or `nestrix.entry = job`; `scheduled` for `nestrix.entry = scheduled`; else
 *   `other`.
 * - `user_id`: the string attribute `user.id`.
 * - indexed attributes (issue #27, D-102): the span's values of the `NESTRIX_INDEXED_ATTRIBUTES`
 *   keys, as text (a string cut to 256 characters, a finite number in decimal, `true`/`false`);
 *   other values (arrays, empty strings) are not indexed. Request ids: the recorded
 *   `http.request.header.x-request-id` / `http.response.header.x-request-id` values (the header
 *   allowlist records them as string arrays), each cut to 256, at most 4 per span; `REDACTED` is
 *   not a request id.
 * - route rollup (`route_minutes`): every server span with `http.request.method`, keyed by
 *   method, route (`(unmatched)` without `http.route`) and the minute of its end; an error there
 *   is a status error or a 5xx (the embedded route statistics' definition: 5xx or thrown handler).
 *   A span carrying `nestrix.sampling.probability` p counts as `1 / p` requests (issue #30,
 *   D-100), rounded to a whole number per span without bias (`writer.ts`); others count once.
 * - class rollup (`class_minutes`): every span with string `nestrix.class` and `nestrix.method`.
 * - environment (D-101): `environmentOf` of the resource (the receiver has already replaced it with
 *   the ingest key's environment when the key is bound to one); `null` is unset.
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
import {
  isErrorOccurrence,
  isFailedSpan,
  primaryException,
} from "./error-facts.js";
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
  /** `environmentOf(attributes)`: `null` is unset (D-101). */
  environment: string | null;
  attributes: IngestAttributes;
}

/** The semantic-convention key of the environment, and the deprecated one read when it is absent. */
export const ENVIRONMENT_KEY = "deployment.environment.name";
export const LEGACY_ENVIRONMENT_KEY = "deployment.environment";
/**
 * The stored name of "no environment" in the API (`environment=unset`). A resource that claims it
 * is stored as unset (`NULL`), so the name always means one thing (D-101).
 */
export const UNSET_ENVIRONMENT = "unset";
/** Longest environment name stored; a longer one is cut (the query parameter's bound). */
export const MAX_ENVIRONMENT_LENGTH = 256;

/**
 * The environment of a resource (D-101): the string `deployment.environment.name`, else the string
 * `deployment.environment`; trimmed, cut to 256 characters, made safe for PostgreSQL. `null`
 * (unset) when neither is a non-empty string, or the value is `unset`. Never throws.
 */
export function environmentOf(
  attributes: IngestAttributes | undefined,
): string | null {
  if (attributes === null || typeof attributes !== "object") return null;
  for (const key of [ENVIRONMENT_KEY, LEGACY_ENVIRONMENT_KEY]) {
    const value = attributes[key];
    if (typeof value !== "string") continue;
    const name = cleanString(value).trim().slice(0, MAX_ENVIRONMENT_LENGTH);
    if (name === "") continue;
    return name === UNSET_ENVIRONMENT ? null : name;
  }
  return null;
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
    environment: environmentOf(attributes),
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

/** Longest indexed attribute value or request id (D-102); the query side compares exactly. */
export const MAX_INDEXED_VALUE_LENGTH = 256;
const MAX_REQUEST_IDS_PER_SPAN = 4;
const REQUEST_ID_ATTRIBUTES = [
  "http.request.header.x-request-id",
  "http.response.header.x-request-id",
] as const;

function cutIndexed(text: string): string {
  if (text.length <= MAX_INDEXED_VALUE_LENGTH) return text;
  const last = text.charCodeAt(MAX_INDEXED_VALUE_LENGTH - 1);
  // Never inside a surrogate pair (cleanString made the input well-formed).
  return text.slice(
    0,
    last >= 0xd800 && last <= 0xdbff
      ? MAX_INDEXED_VALUE_LENGTH - 1
      : MAX_INDEXED_VALUE_LENGTH,
  );
}

/** An attribute value as the attribute filters compare it, or `null` when it is not indexed. */
export function indexedTextOf(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : cutIndexed(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

function indexedAttributesOf(
  a: IngestAttributes,
  keys: ReadonlySet<string> | undefined,
): Record<string, string> | null {
  if (keys === undefined || keys.size === 0) return null;
  let out: Record<string, string> | null = null;
  for (const key of keys) {
    if (!Object.hasOwn(a, key)) continue;
    const text = indexedTextOf(a[key]);
    if (text === null) continue;
    out ??= {};
    out[key] = text;
  }
  return out;
}

function requestIdsOf(a: IngestAttributes): string[] {
  const out: string[] = [];
  for (const key of REQUEST_ID_ATTRIBUTES) {
    if (!Object.hasOwn(a, key)) continue;
    const value = a[key];
    const list = Array.isArray(value) ? value : [value];
    for (const item of list) {
      if (out.length >= MAX_REQUEST_IDS_PER_SPAN) return out;
      if (typeof item !== "string" || item === "" || item === "REDACTED") {
        continue;
      }
      const id = cutIndexed(item);
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

function stringAttr(a: IngestAttributes, key: string): string | null {
  const v = a[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/** The keep probability Nestrix writes on each local root it exports (issue #30, D-100). */
export const ATTR_SAMPLING_PROBABILITY = "nestrix.sampling.probability";
/** Smallest probability honoured: a weight above 1,000,000 per span is not credible. */
const MIN_SAMPLING_PROBABILITY = 1e-6;

/**
 * How many requests one stored server span stands for in the route rollup: `1 / p` for a span
 * that carries a numeric `nestrix.sampling.probability` p in (0, 1] (clamped at 1e-6), else 1.
 * A span from a host-owned sampler, from another SDK, or with a remote parent carries none: its
 * rate is unknown here and it counts once, as before.
 */
export function samplingWeightOf(a: IngestAttributes): number {
  const p = a[ATTR_SAMPLING_PROBABILITY];
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0 || p > 1) {
    return 1;
  }
  return 1 / Math.max(p, MIN_SAMPLING_PROBABILITY);
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
  /** The resource's environment (D-101); `null` is unset. */
  environment: string | null;
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
  /** Failed under `isFailedSpan`: marks its trace `has_errors` (D-94). */
  isFailure: boolean;
  /** `isErrorOccurrence` (D-93), before the legacy parent rule. */
  isOccurrence: boolean;
  /** Hash of the primary exception's identity, for an error span that has one (D-93). */
  errorKey: string | null;
  traceType: TraceType;
  /** A consumer span or `nestrix.entry = 'job'`: marks its trace `has_job`, whatever the root. */
  isJob: boolean;
  userId: string | null;
  /** Values of the `NESTRIX_INDEXED_ATTRIBUTES` keys the span has, as text; `null`: none (D-102). */
  indexedAttributes: Record<string, string> | null;
  /** Recorded `x-request-id` request and response header values (D-102). */
  requestIds: string[];
  className: string | null;
  methodName: string | null;
  classKind: string;
  /** Counted in `route_minutes`. */
  isRouteSpan: boolean;
  /** Error for the route rollup: status error or 5xx. */
  isRouteError: boolean;
  /** Requests this span stands for in the route rollup (`samplingWeightOf`; 1 when unknown). */
  routeWeight: number;
}

/**
 * A row, or `null` when the span's times cannot be stored (the receiver checks them first).
 * `indexedKeys`: `NESTRIX_INDEXED_ATTRIBUTES` (D-102); absent or empty, nothing is indexed.
 */
export function deriveSpan(
  span: IngestSpan,
  resource: ResourceRow,
  indexedKeys?: ReadonlySet<string>,
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
    environment: resource.environment,
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
    isFailure: isFailedSpan(statusCode, events),
    isOccurrence: isErrorOccurrence(statusCode, events),
    errorKey: isError ? errorKeyOf(events) : null,
    traceType: traceTypeOf(span.kind, attributes),
    isJob: span.kind === "consumer" || attributes["nestrix.entry"] === "job",
    userId: stringAttr(attributes, "user.id"),
    indexedAttributes: indexedAttributesOf(attributes, indexedKeys),
    requestIds: requestIdsOf(attributes),
    className,
    methodName,
    classKind:
      component !== null && CLASS_KINDS.has(component) ? component : "provider",
    isRouteSpan: span.kind === "server" && httpMethod !== null,
    isRouteError: isError || (httpStatus !== null && httpStatus >= 500),
    routeWeight: samplingWeightOf(attributes),
  };
}

/** The legacy parent rule's key of a span's primary exception, or `null` without one (D-93). */
export function errorKeyOf(events: readonly StoredEvent[]): string | null {
  const primary = primaryException(events);
  if (primary === undefined) return null;
  const a = primary.attributes;
  return createHash("sha256")
    .update(
      JSON.stringify([
        a["exception.type"] ?? null,
        a["exception.message"] ?? null,
        a["exception.stacktrace"] ?? null,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

/** Rollup key and bucket helpers. */
export function minuteDay(minuteMs: number): number {
  return Math.floor(minuteMs / DAY_MS);
}

export function histogramBucket(durationMs: number): number {
  return bucketIndex(durationMs);
}
