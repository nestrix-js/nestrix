/**
 * Exception events Nestrix records (issues #22, #24, #25; D-93, D-94).
 *
 * Every place Nestrix records an exception (method spans, `withSpan`, the HTTP interceptor, RPC
 * and client spans, BullMQ spans, process errors, `recordError`) goes through
 * {@link recordExceptionEvent}, so the event looks the same everywhere and carries two marks the
 * query side reads:
 *
 * - `nestrix.exception.propagated = true`: Nestrix already recorded this error object in this trace
 *   (on a deeper span, or earlier on this one). One thrown error that travels up from a service
 *   through the controller to the server span is one occurrence, on the deepest span; the events
 *   above it stay in the trace view as context.
 * - `nestrix.exception.expected = true`: the exception is an answer, not a defect. By default one
 *   whose mapped status ({@link exceptionStatus}) is below 500; `errors.expected` changes the rule.
 *
 * The span's status is not changed here: each caller keeps its own rule.
 *
 * Imports `@opentelemetry/api` only (rule 5). Nothing here throws to its caller except what the
 * span's own methods throw, and every caller already guards those.
 */
import {
  type Attributes,
  type AttributeValue,
  type Context,
  context,
  createContextKey,
  INVALID_SPANID,
  INVALID_TRACEID,
  type Span,
  type TimeInput,
  trace,
} from "@opentelemetry/api";
import { diagnostics } from "../diagnostics.js";
import type { ClassMatcher } from "../options.js";

export const ATTR_EXCEPTION_PROPAGATED = "nestrix.exception.propagated";
export const ATTR_EXCEPTION_EXPECTED = "nestrix.exception.expected";
export const ATTR_EXCEPTION_ESCAPED = "exception.escaped";
const ATTR_EXCEPTION_TYPE = "exception.type";
const ATTR_EXCEPTION_MESSAGE = "exception.message";
const ATTR_EXCEPTION_STACKTRACE = "exception.stacktrace";
const EXCEPTION_EVENT = "exception";

/**
 * The status an exception maps to: `getStatus()` of an `HttpException` (duck-typed, so a second
 * copy of `@nestjs/common` still counts), otherwise 500.
 */
export function exceptionStatus(error: unknown): number {
  try {
    if (error !== null && typeof error === "object") {
      const getStatus = (error as { getStatus?: unknown }).getStatus;
      const getResponse = (error as { getResponse?: unknown }).getResponse;
      if (
        typeof getStatus === "function" &&
        typeof getResponse === "function"
      ) {
        const status: unknown = getStatus.call(error);
        if (typeof status === "number" && Number.isInteger(status))
          return status;
      }
    }
  } catch {
    // An exception whose getStatus throws is treated as unexpected.
  }
  return 500;
}

/** `error.type` for an exception: its constructor's name, else `_OTHER`. */
export function exceptionType(error: unknown): string {
  try {
    if (error !== null && typeof error === "object") {
      const name = (error as { constructor?: { name?: unknown } }).constructor
        ?.name;
      if (typeof name === "string" && name !== "") return name;
    }
  } catch {
    // Fall through.
  }
  return "_OTHER";
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "(unprintable)";
  }
}

/** `instanceof Error`, false when the check itself throws (a revoked Proxy). */
function isError(value: unknown): boolean {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function read(error: object, key: string): unknown {
  try {
    return (error as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * The `exception.*` attributes of `error`, as the SDK's `recordException` builds them (`code` before
 * `name` for the type, then `message` and `stack`), read without letting a throwing getter out.
 */
export function exceptionAttributes(error: unknown): Attributes {
  const out: Attributes = {};
  if (typeof error === "string") {
    out[ATTR_EXCEPTION_MESSAGE] = error;
    return out;
  }
  if (error === null || typeof error !== "object") {
    out[ATTR_EXCEPTION_MESSAGE] = safeString(error);
    return out;
  }
  const code = read(error, "code");
  const name = read(error, "name");
  if (code) {
    out[ATTR_EXCEPTION_TYPE] = safeString(code);
  } else if (typeof name === "string" && name !== "") {
    out[ATTR_EXCEPTION_TYPE] = name;
  }
  const message = read(error, "message");
  if (typeof message === "string" && message !== "") {
    out[ATTR_EXCEPTION_MESSAGE] = message;
  }
  const stack = read(error, "stack");
  if (typeof stack === "string" && stack !== "") {
    out[ATTR_EXCEPTION_STACKTRACE] = stack;
  }
  // Not the SDK's rule: an object with no `code` or `name` (a plain object an RPC transport
  // rethrows) is typed by its constructor, and one with no message gets `String(error)`, as the
  // interceptor and the RPC spans did before (D-93).
  if (out[ATTR_EXCEPTION_TYPE] === undefined) {
    out[ATTR_EXCEPTION_TYPE] = exceptionType(error);
  }
  if (out[ATTR_EXCEPTION_MESSAGE] === undefined && !isError(error)) {
    out[ATTR_EXCEPTION_MESSAGE] = safeString(error);
  }
  return out;
}

// ---- expected exceptions (#25) -----------------------------------------------------------------

/** `errors.expected` as resolved: `undefined` is the default rule (mapped status below 500). */
export type ExpectedRule =
  | false
  | readonly ClassMatcher[]
  | ((error: unknown) => boolean | undefined)
  | undefined;

const rules: Array<{ rule: ExpectedRule }> = [];

function matchesClass(matchers: readonly ClassMatcher[], error: unknown) {
  if (error === null || typeof error !== "object") return false;
  const name = exceptionType(error);
  for (const m of matchers) {
    try {
      if (typeof m === "function") {
        if (error instanceof (m as abstract new (...a: never[]) => unknown))
          return true;
      } else if (typeof m === "string") {
        if (m === name) return true;
      } else if (m instanceof RegExp) {
        m.lastIndex = 0;
        if (m.test(name)) return true;
      }
    } catch (failure) {
      diagnostics.countFailure("errors.expected", failure);
    }
  }
  return false;
}

/**
 * Whether `error` is expected under the first installed app's `errors.expected` (like `sampleRate`,
 * the first app's rule wins), or the default rule when none is installed. Never throws.
 */
export function isExpectedException(error: unknown): boolean {
  try {
    const rule = rules[0]?.rule;
    if (rule === false) return false;
    if (typeof rule === "function") {
      try {
        const answer: unknown = rule(error);
        if (answer === true || answer === false) return answer;
      } catch (failure) {
        diagnostics.countFailure("errors.expected", failure);
      }
    } else if (Array.isArray(rule) && matchesClass(rule, error)) {
      return true;
    }
    return exceptionStatus(error) < 500;
  } catch (failure) {
    diagnostics.countFailure("errors.expected", failure);
    return false;
  }
}

let enabledApps = 0;

/**
 * Called once per enabled app (NestrixCore): installs its `errors.expected` rule and counts it as
 * an enabled app, so `recordError` works. Returns the disposer. Never throws.
 */
export function installErrorTracking(rule: ExpectedRule): () => void {
  const entry = { rule };
  try {
    rules.push(entry);
    enabledApps++;
  } catch (error) {
    diagnostics.countFailure("errors.install", error);
    return () => undefined;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const i = rules.indexOf(entry);
    if (i >= 0) rules.splice(i, 1);
    enabledApps--;
  };
}

/** Whether at least one enabled Nestrix app is running in this process. */
export function errorTrackingEnabled(): boolean {
  return enabledApps > 0;
}

// ---- once per error object per trace (#22) ------------------------------------------------------

/**
 * Where an error object was recorded in one trace: the span ids that recorded it and their
 * parents. A later recording is propagation only when its span is one of those parents (the error
 * travelled up), or the local root of the work (the request's span, a job's root), and an earlier
 * recording was not expected. Two sibling spans throwing one shared error object each count.
 */
interface Recording {
  /** Parent span ids of the spans that recorded the error, and those spans' own ids. */
  readonly spans: Set<string>;
  /** Some recording in this trace was not expected: a propagation source. */
  unexpected: boolean;
}

/** Error object to its recordings per trace. Weak: never keeps an error alive. */
const recorded = new WeakMap<object, Map<string, Recording>>();
/** Traces kept per error object (a shared error object thrown in many concurrent traces). */
export const MAX_TRACES_PER_ERROR = 64;
const MAX_SPANS_PER_RECORDING = 64;

/**
 * Messages recorded inside one BullMQ job attempt (keyed by the attempt's consumer span id), for
 * BullMQ's "job failed" event, which carries only `err.message`. Only filled inside an attempt
 * (the context carries {@link JOB_ATTEMPT_KEY}), each message cut to {@link MAX_MESSAGE_LENGTH},
 * dropped when the attempt's span ends, and bounded: the oldest attempt is forgotten first.
 */
const attemptMessages = new Map<string, string[]>();
const MAX_ATTEMPTS = 1024;
const MAX_MESSAGES_PER_ATTEMPT = 16;
export const MAX_MESSAGE_LENGTH = 256;

/** The BullMQ job attempt (its consumer span id) a context runs in; set by `bullmqTelemetry()`. */
export const JOB_ATTEMPT_KEY = createContextKey(
  "@nestrix-js/nestjs bullmq job attempt",
);

function hasIds(traceId: string, spanId: string): boolean {
  return traceId !== INVALID_TRACEID && spanId !== INVALID_SPANID;
}

/** The parent span id of an SDK span (`parentSpanContext` in SDK 3, `parentSpanId` before). */
function parentIdOf(span: Span): string | undefined {
  try {
    const s = span as unknown as {
      parentSpanContext?: { spanId?: unknown };
      parentSpanId?: unknown;
    };
    const id = s.parentSpanContext?.spanId ?? s.parentSpanId;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is object {
  return (
    value !== null && (typeof value === "object" || typeof value === "function")
  );
}

/**
 * Notes `error` as recorded on `span` and returns whether this is propagation of an earlier,
 * unexpected recording of the same object (see {@link Recording}).
 */
function note(
  error: unknown,
  traceId: string,
  span: Span,
  spanId: string,
  root: boolean,
  expected: boolean,
): boolean {
  if (!isObject(error)) return false;
  let traces = recorded.get(error);
  if (traces === undefined) {
    traces = new Map();
    recorded.set(error, traces);
  }
  let rec = traces.get(traceId);
  let propagated = false;
  if (rec === undefined) {
    if (traces.size >= MAX_TRACES_PER_ERROR) {
      const oldest = traces.keys().next();
      if (!oldest.done) traces.delete(oldest.value);
    }
    rec = { spans: new Set(), unexpected: false };
    traces.set(traceId, rec);
  } else {
    propagated = rec.unexpected && (root || rec.spans.has(spanId));
  }
  if (!expected) rec.unexpected = true;
  if (rec.spans.size < MAX_SPANS_PER_RECORDING) {
    rec.spans.add(spanId);
    const parent = parentIdOf(span);
    if (parent !== undefined) rec.spans.add(parent);
  }
  return propagated;
}

/** Whether `error` (an object) has an unexpected recording in `traceId`. */
function recordedIn(error: unknown, traceId: string): boolean {
  return (
    isObject(error) && recorded.get(error)?.get(traceId)?.unexpected === true
  );
}

function attemptOf(): string | undefined {
  try {
    const value = context.active().getValue(JOB_ATTEMPT_KEY);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function noteMessage(attempt: string, message: string): void {
  let list = attemptMessages.get(attempt);
  if (list === undefined) {
    if (attemptMessages.size >= MAX_ATTEMPTS) {
      const oldest = attemptMessages.keys().next();
      if (!oldest.done) attemptMessages.delete(oldest.value);
    }
    list = [];
    attemptMessages.set(attempt, list);
  }
  const key = message.slice(0, MAX_MESSAGE_LENGTH);
  if (!list.includes(key)) {
    list.push(key);
    if (list.length > MAX_MESSAGES_PER_ATTEMPT) list.shift();
  }
}

/** Forgets the messages of a job attempt whose span ended. Never throws. */
export function forgetAttempt(attempt: string): void {
  try {
    attemptMessages.delete(attempt);
  } catch {
    // Nothing to do.
  }
}

/** Attempts with messages held; for tests. */
export function heldAttemptsForTests(): number {
  return attemptMessages.size;
}

/** For tests: forget what was recorded. */
export function resetRecordedForTests(): void {
  attemptMessages.clear();
}

export interface ExceptionEventOptions {
  /** `exception.escaped`; unset unless given (recordError sets `false`). */
  readonly escaped?: boolean;
  /** Extra event attributes (recordError's); never override `exception.*` or `nestrix.exception.*`. */
  readonly attributes?: unknown;
  /**
   * BullMQ's "job failed": the error arrives as its message only. It is propagation when an
   * unexpected exception with that message was recorded inside this attempt (`span` is the
   * attempt's consumer span).
   */
  readonly byMessage?: boolean;
  /** `span` is the local root of its work (the request's span, a job's root, `recordError`'s target). */
  readonly root?: boolean;
  /**
   * Overrides the expected rule: `false` for a failure that is never an answer (an uncaught
   * exception, a failed job attempt, a job's or scheduled tick's root method).
   */
  readonly expected?: boolean;
  /** `recordError`: a wrapper whose `cause` was already recorded in this trace is propagation. */
  readonly followCause?: boolean;
  readonly time?: TimeInput;
}

export interface RecordedException {
  readonly propagated: boolean;
  readonly expected: boolean;
}

function isAttributeValue(value: unknown): value is AttributeValue {
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(value as number);
  if (!Array.isArray(value)) return false;
  return value.every(
    (v) =>
      v === null ||
      v === undefined ||
      typeof v === "string" ||
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v)),
  );
}

/** Own enumerable attribute-valued entries of `input`, without Nestrix's and the exception keys. */
function userAttributes(input: unknown, out: Attributes): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return;
  }
  let keys: string[];
  try {
    keys = Object.keys(input);
  } catch {
    return;
  }
  for (const key of keys.slice(0, 64)) {
    if (key.startsWith("exception.") || key.startsWith("nestrix.exception.")) {
      continue;
    }
    const value = read(input, key);
    if (isAttributeValue(value)) out[key] = value;
  }
}

/**
 * Adds an `exception` event for `error` to `span`, marked propagated and/or expected as above.
 * Throws only what the span's `addEvent`/`spanContext` throw.
 */
export function recordExceptionEvent(
  span: Span,
  error: unknown,
  options?: ExceptionEventOptions,
): RecordedException {
  const attributes: Attributes = {};
  if (options?.attributes !== undefined) {
    userAttributes(options.attributes, attributes);
  }
  Object.assign(attributes, exceptionAttributes(error));
  const expected =
    typeof options?.expected === "boolean"
      ? options.expected
      : isExpectedException(error);
  const sc = span.spanContext();
  let propagated = false;
  if (hasIds(sc.traceId, sc.spanId)) {
    const message = attributes[ATTR_EXCEPTION_MESSAGE];
    if (options?.byMessage === true) {
      propagated =
        typeof message === "string" &&
        attemptMessages
          .get(sc.spanId)
          ?.includes(message.slice(0, MAX_MESSAGE_LENGTH)) === true;
    } else {
      propagated = note(
        error,
        sc.traceId,
        span,
        sc.spanId,
        options?.root === true,
        expected,
      );
      if (!propagated && options?.followCause === true) {
        propagated = recordedIn(read(error as object, "cause"), sc.traceId);
      }
      if (!expected && typeof message === "string" && message !== "") {
        const attempt = attemptOf();
        if (attempt !== undefined) noteMessage(attempt, message);
      }
    }
  }
  if (propagated) attributes[ATTR_EXCEPTION_PROPAGATED] = true;
  if (expected) attributes[ATTR_EXCEPTION_EXPECTED] = true;
  if (options?.escaped !== undefined) {
    attributes[ATTR_EXCEPTION_ESCAPED] = options.escaped;
  }
  span.addEvent(EXCEPTION_EVENT, attributes, options?.time);
  return { propagated, expected };
}

// ---- the local root of the current trace (#24) ---------------------------------------------------

/**
 * The span Nestrix started as the local root of the work running in a context (a job's or a
 * scheduled tick's root, an RPC server span); HTTP requests are found through their request state.
 */
export const LOCAL_ROOT_KEY = createContextKey(
  "@nestrix-js/nestjs local root span",
);

/**
 * `ctx` (which holds `span`), marked with `span` as its local root when `parent` has no valid span
 * or a remote one. Never throws: on a failure `ctx` is returned as is.
 */
export function withLocalRoot(
  parent: Context,
  span: Span,
  ctx: Context,
): Context {
  try {
    const sc = trace.getSpanContext(parent);
    const local =
      sc !== undefined &&
      sc.isRemote !== true &&
      sc.traceId !== INVALID_TRACEID &&
      sc.spanId !== INVALID_SPANID;
    return local ? ctx : ctx.setValue(LOCAL_ROOT_KEY, span);
  } catch (error) {
    diagnostics.countFailure("errors.local-root", error);
    return ctx;
  }
}

/** `ctx` with `span` as its local root, whatever its parent (a span started with `root: true`). */
export function markLocalRoot(ctx: Context, span: Span): Context {
  try {
    return ctx.setValue(LOCAL_ROOT_KEY, span);
  } catch (error) {
    diagnostics.countFailure("errors.local-root", error);
    return ctx;
  }
}

/** The local root recorded in `ctx`, if any. Never throws. */
export function localRootOf(ctx: Context): Span | undefined {
  try {
    const value = ctx.getValue(LOCAL_ROOT_KEY) as Span | undefined;
    return value !== undefined &&
      value !== null &&
      typeof (value as Span).spanContext === "function"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
