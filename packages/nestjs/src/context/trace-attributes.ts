/**
 * Trace attributes of the work running now (issue #27, D-102): the `context` option's values on
 * an HTTP request's server span, `setTraceAttributes()` on the local root of a job, a scheduled
 * tick or a request, and the opt-in propagation of allow-listed keys to jobs (BullMQ metadata,
 * read again in the worker) and, when asked for, to outgoing HTTP requests, as W3C baggage.
 *
 * Nothing is recorded unless the app configures `context` or calls `setTraceAttributes`, and
 * nothing is propagated unless `contextPropagation.keys` lists the key, in the sending process
 * (what goes out) and in the receiving one (what is read back). Nestrix never puts these values
 * into the OpenTelemetry context's baggage: a host propagator that sends baggage would otherwise
 * carry them to every downstream service. The `baggage` entries are written by Nestrix's own
 * injection sites only.
 *
 * Imports `@opentelemetry/api` only (AGENTS.md rule 5). Nothing here throws (rule 1).
 */
import {
  type AttributeValue,
  type Context,
  context,
  createContextKey,
  type Span,
  trace,
} from "@opentelemetry/api";
import { diagnostics } from "../diagnostics.js";
import { errorTrackingEnabled, localRootOf } from "../errors/exception.js";
import { getStateFromContext } from "../http/request-state.js";
import {
  MAX_TRACE_ATTRIBUTE_VALUE_LENGTH,
  MAX_TRACE_ATTRIBUTES,
  traceAttributeKeyProblem,
} from "./keys.js";

export {
  MAX_PROPAGATED_KEYS,
  MAX_TRACE_ATTRIBUTE_VALUE_LENGTH,
  MAX_TRACE_ATTRIBUTES,
  TRACE_ATTRIBUTE_KEY,
  traceAttributeKeyProblem,
} from "./keys.js";

/** Bytes of `baggage` Nestrix adds to one carrier, at most (W3C allows 8192 in all). */
export const MAX_BAGGAGE_BYTES = 4096;

function cut(text: string): string {
  if (text.length <= MAX_TRACE_ATTRIBUTE_VALUE_LENGTH) return text;
  const last = text.charCodeAt(MAX_TRACE_ATTRIBUTE_VALUE_LENGTH - 1);
  return text.slice(
    0,
    last >= 0xd800 && last <= 0xdbff
      ? MAX_TRACE_ATTRIBUTE_VALUE_LENGTH - 1
      : MAX_TRACE_ATTRIBUTE_VALUE_LENGTH,
  );
}

/**
 * The attribute value for `value`: a non-empty string (cut), a finite number, a boolean.
 * `undefined` for none (`undefined`, `null`, `''`); `null` for an invalid value.
 */
function attributeValueOf(value: unknown): AttributeValue | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value === "" ? undefined : cut(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return null;
}

/** The value as text, as baggage and the backends' filters compare it. */
export function attributeText(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return undefined;
}

function isThenable(value: unknown): boolean {
  try {
    return (
      value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      typeof (value as { then?: unknown }).then === "function"
    );
  } catch {
    return false;
  }
}

/**
 * Valid entries of `input` (a plain object of attribute values). An invalid key or value is
 * skipped and reported through `onInvalid` with a description that never contains the value.
 * Throws only what reading `input`'s own properties throws.
 */
export function readTraceAttributes(
  input: unknown,
  onInvalid: (why: string) => void,
): Map<string, AttributeValue> {
  const out = new Map<string, AttributeValue>();
  if (input === undefined || input === null) return out;
  if (typeof input !== "object" || Array.isArray(input) || isThenable(input)) {
    if (isThenable(input)) {
      try {
        (input as PromiseLike<unknown>).then(undefined, () => undefined);
      } catch {
        // A thenable whose `then` throws: nothing pending to handle.
      }
      onInvalid("a promise (it must be synchronous)");
    } else {
      onInvalid(
        Array.isArray(input) ? "an array" : `a value of type ${typeof input}`,
      );
    }
    return out;
  }
  let keys = Object.keys(input);
  if (keys.length > MAX_TRACE_ATTRIBUTES) {
    onInvalid(`more than ${MAX_TRACE_ATTRIBUTES} keys`);
    keys = keys.slice(0, MAX_TRACE_ATTRIBUTES);
  }
  for (const key of keys) {
    const problem = traceAttributeKeyProblem(key);
    if (problem !== undefined) {
      onInvalid(`a key that ${problem}`);
      continue;
    }
    const value = attributeValueOf((input as Record<string, unknown>)[key]);
    if (value === null) {
      onInvalid(
        "a value that is not a string, a finite number, a boolean or undefined",
      );
      continue;
    }
    if (value !== undefined) out.set(key, value);
  }
  return out;
}

// ---- what each local root carries ---------------------------------------------------------------

/**
 * The trace attributes Nestrix set on a local root span (a request's server span, a job's consumer
 * span, a scheduled tick's root), as text, for propagation. Weak: dropped with the span.
 */
const recordsBySpan = new WeakMap<Span, Map<string, string>>();

/** Keys set through `context` or `setTraceAttributes` in this process, for the dashboard's filters. */
const seenKeys = new Set<string>();
const MAX_SEEN_KEYS = 32;

/** Keys this process set (at most 32, first come), sorted: the embedded dashboard offers them as filters. */
export function seenTraceAttributeKeys(): string[] {
  return [...seenKeys].sort();
}

/** Records `attributes` on `span` (which must be recording) and remembers them for propagation. */
export function applyTraceAttributes(
  span: Span,
  attributes: ReadonlyMap<string, AttributeValue>,
): void {
  if (attributes.size === 0) return;
  let record = recordsBySpan.get(span);
  if (record === undefined) {
    record = new Map();
    recordsBySpan.set(span, record);
  }
  for (const [key, value] of attributes) {
    span.setAttribute(key, value);
    const text = attributeText(value);
    if (
      text !== undefined &&
      (record.has(key) || record.size < MAX_TRACE_ATTRIBUTES)
    ) {
      record.set(key, text);
    }
    if (seenKeys.size < MAX_SEEN_KEYS) seenKeys.add(key);
  }
}

/** For tests. */
export function resetSeenTraceAttributeKeysForTests(): void {
  seenKeys.clear();
}

// ---- propagation configuration (process-wide, first enabled app wins, like `sampleRate`) -------

export interface ResolvedContextPropagation {
  /** Keys carried as baggage; empty: nothing is propagated or read back. */
  readonly keys: ReadonlySet<string>;
  /** Also on outgoing HTTP requests (`node:http`, `fetch`/undici). */
  readonly outgoing: boolean;
}

const installed: ResolvedContextPropagation[] = [];

/** Called once per enabled app (NestrixCore). Returns the disposer. Never throws. */
export function installContextPropagation(
  config: ResolvedContextPropagation,
): () => void {
  try {
    if (config.keys.size === 0) return () => undefined;
    const entry = { ...config };
    installed.push(entry);
    for (const key of config.keys) {
      if (seenKeys.size < MAX_SEEN_KEYS) seenKeys.add(key);
    }
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const i = installed.indexOf(entry);
      if (i >= 0) installed.splice(i, 1);
    };
  } catch (error) {
    diagnostics.countFailure("context.install", error);
    return () => undefined;
  }
}

function activePropagation(): ResolvedContextPropagation | undefined {
  return installed[0];
}

// ---- the local root of the current work ---------------------------------------------------------

function isRecording(span: Span | undefined): span is Span {
  try {
    return span?.isRecording() === true;
  } catch {
    return false;
  }
}

function sameTrace(span: Span, traceId: string | undefined): boolean {
  if (traceId === undefined) return true;
  try {
    return span.spanContext().traceId === traceId;
  } catch {
    return false;
  }
}

/**
 * The local root of the work in `ctx`, as `recordError` finds it (D-93): the request's server
 * span, then the nearest local root Nestrix started, each only when in the active span's trace.
 * `ended` roots are included (for propagation after the response closed), unless `recording`.
 */
function localRoot(ctx: Context, recording: boolean): Span | undefined {
  const active = trace.getSpan(ctx);
  let traceId: string | undefined;
  try {
    traceId = active?.spanContext().traceId;
  } catch {
    traceId = undefined;
  }
  const state = getStateFromContext(ctx);
  if (state !== undefined) {
    // The request's `context` result, read once, now if not yet (a job queued by the handler).
    if (!state.ended) state.readContext?.();
    const span = state.span;
    if (
      (!recording || (!state.ended && isRecording(span))) &&
      sameTrace(span, traceId)
    ) {
      return span;
    }
  }
  const root = localRootOf(ctx);
  if (
    root !== undefined &&
    (!recording || isRecording(root)) &&
    sameTrace(root, traceId)
  ) {
    return root;
  }
  return undefined;
}

/**
 * `setTraceAttributes(attributes)`: sets attributes on the local root span of the current trace,
 * for code paths without a request (a job, a scheduled tick) or for values known only inside the
 * handler. The target is the HTTP request's server span, else the job's, scheduled tick's or RPC
 * handler's root span Nestrix started, else the active span; outside any span, nothing. Keys
 * listed in `contextPropagation.keys` are also carried to the jobs this work queues.
 *
 * Values: strings (cut to 256 characters), finite numbers, booleans; `undefined` skips a key. At
 * most 32 keys per call; names start with a letter and use letters, digits, `_`, `.` and `-`; the
 * `nestrix.`, `http.`, `url.`, `exception.` (and other semantic-convention) prefixes and `user.id`
 * are refused. An invalid entry is skipped and counted. They go through `redact` like every
 * attribute. Never throws; does nothing while no enabled Nestrix app runs.
 */
export function setTraceAttributes(
  attributes: Record<string, string | number | boolean | undefined>,
): void {
  try {
    if (!errorTrackingEnabled()) return;
    const ctx = context.active();
    let target = localRoot(ctx, true);
    if (target === undefined) {
      const active = trace.getSpan(ctx);
      if (isRecording(active)) target = active;
    }
    if (target === undefined) return;
    const values = readTraceAttributes(attributes, (why) =>
      diagnostics.countFailure(
        "context.set-trace-attributes",
        new TypeError(`setTraceAttributes was given ${why}; it was skipped`),
      ),
    );
    applyTraceAttributes(target, values);
  } catch (error) {
    diagnostics.countFailure("context.set-trace-attributes", error);
  }
}

// ---- baggage ------------------------------------------------------------------------------------

/** Allow-listed entries a job brought with it, read from its metadata's `baggage` (worker side). */
const INBOUND_KEY = createContextKey(
  "@nestrix-js/nestjs inbound trace attributes",
);

/** The entries to propagate from `ctx`: allow-listed keys of its local root's record. */
function outboundEntries(
  ctx: Context,
  config: ResolvedContextPropagation,
): Map<string, string> | undefined {
  const root = localRoot(ctx, false);
  const record = root === undefined ? undefined : recordsBySpan.get(root);
  const out = new Map<string, string>();
  if (record !== undefined) {
    for (const [key, value] of record)
      if (config.keys.has(key)) out.set(key, value);
  }
  return out.size > 0 ? out : undefined;
}

/** `key=value` list items of a baggage header, with their raw text. */
function baggageItems(header: string): { key: string; raw: string }[] {
  const items: { key: string; raw: string }[] = [];
  for (const part of header.split(",")) {
    const raw = part.trim();
    if (raw === "") continue;
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    items.push({ key: raw.slice(0, eq).trim(), raw });
  }
  return items;
}

/**
 * `existing` (a baggage header another propagator wrote, or none) with every allow-listed key
 * removed and `entries` added, within {@link MAX_BAGGAGE_BYTES} for Nestrix's part. Removing the
 * allow-listed keys first means a `tenant.id` that arrived in an incoming request's baggage is
 * never passed on as this work's own: only the value Nestrix set is.
 */
export function mergeBaggage(
  existing: string | undefined,
  entries: ReadonlyMap<string, string>,
  keys: ReadonlySet<string>,
): string | undefined {
  const kept =
    existing === undefined
      ? []
      : baggageItems(existing)
          .filter((i) => !keys.has(i.key))
          .map((i) => i.raw);
  let budget = MAX_BAGGAGE_BYTES;
  for (const [key, value] of entries) {
    const item = `${key}=${encodeURIComponent(value)}`;
    if (item.length + 1 > budget) continue;
    budget -= item.length + 1;
    kept.push(item);
  }
  return kept.length > 0 ? kept.join(",") : undefined;
}

/** Allow-listed entries of a baggage header, decoded and cut. Never throws. */
export function parseBaggage(
  header: unknown,
  keys: ReadonlySet<string>,
): Map<string, string> | undefined {
  if (typeof header !== "string" || header === "" || keys.size === 0)
    return undefined;
  const out = new Map<string, string>();
  for (const item of baggageItems(header.slice(0, 8192))) {
    if (!keys.has(item.key) || out.has(item.key)) continue;
    const text = item.raw.slice(item.raw.indexOf("=") + 1);
    const semi = text.indexOf(";");
    const encoded = (semi < 0 ? text : text.slice(0, semi)).trim();
    let value: string;
    try {
      value = decodeURIComponent(encoded);
    } catch {
      continue;
    }
    if (value !== "") out.set(item.key, cut(value));
  }
  return out.size > 0 ? out : undefined;
}

/**
 * BullMQ's `getMetadata` carrier: adds the allow-listed entries of the work in `ctx` to its
 * `baggage`, and takes allow-listed keys a propagator copied from incoming baggage out of it. With
 * no `contextPropagation.keys`, leaves the carrier as it is. Never throws.
 */
export function addBaggageToCarrier(
  ctx: Context,
  carrier: Record<string, string>,
): void {
  try {
    const config = activePropagation();
    if (config === undefined) return;
    const entries = outboundEntries(ctx, config) ?? new Map<string, string>();
    const existing =
      typeof carrier.baggage === "string" ? carrier.baggage : undefined;
    if (entries.size === 0 && existing === undefined) return;
    const merged = mergeBaggage(existing, entries, config.keys);
    if (merged === undefined) delete carrier.baggage;
    else carrier.baggage = merged;
  } catch (error) {
    diagnostics.countFailure("context.propagate", error);
  }
}

/**
 * For outgoing HTTP requests: the `baggage` value to send, or `undefined` for no change. Only with
 * `contextPropagation.outgoing`. `existing` is what a propagator produced for this request.
 * Never throws.
 */
export function outgoingBaggage(
  ctx: Context,
  existing: string | undefined,
): string | undefined | null {
  try {
    const config = activePropagation();
    if (config === undefined || !config.outgoing) return undefined;
    const entries = outboundEntries(ctx, config) ?? new Map<string, string>();
    // Nothing to add and nothing to take out: the request goes out as the propagator built it.
    if (entries.size === 0 && existing === undefined) return undefined;
    return mergeBaggage(existing, entries, config.keys) ?? null;
  } catch (error) {
    diagnostics.countFailure("context.propagate", error);
    return undefined;
  }
}

/** Worker side: `ctx` with the allow-listed entries of the job's carrier. Never throws. */
export function withInboundBaggage(ctx: Context, carrier: object): Context {
  try {
    const config = activePropagation();
    if (config === undefined) return ctx;
    const entries = parseBaggage(
      (carrier as { baggage?: unknown }).baggage,
      config.keys,
    );
    return entries === undefined ? ctx : ctx.setValue(INBOUND_KEY, entries);
  } catch (error) {
    diagnostics.countFailure("context.propagate", error);
    return ctx;
  }
}

/**
 * Worker side: sets the entries the job brought (`parent` is the context its consumer span was
 * started in) on that span, the job's root, and remembers them, so jobs it queues carry them on.
 * Never throws.
 */
export function applyInboundBaggage(parent: Context, span: Span): void {
  try {
    const entries = parent.getValue(INBOUND_KEY);
    if (!(entries instanceof Map) || entries.size === 0) return;
    if (!isRecording(span)) return;
    applyTraceAttributes(span, entries as Map<string, string>);
  } catch (error) {
    diagnostics.countFailure("context.propagate", error);
  }
}
