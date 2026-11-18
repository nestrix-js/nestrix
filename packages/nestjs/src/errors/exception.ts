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
  if (out[ATTR_EXCEPTION_MESSAGE] === undefined && !(error instanceof Error)) {
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

/** Error object to the traces it was recorded in (normally one). Weak: never keeps an error alive. */
const recorded = new WeakMap<object, string[]>();
const MAX_TRACES_PER_ERROR = 8;

/**
 * Messages recorded per trace, for exceptions that reach Nestrix only as their message (BullMQ's
 * "job failed" event carries `err.message`). Bounded: the oldest trace is forgotten first.
 */
const messages = new Map<string, string[]>();
const MAX_MESSAGE_TRACES = 1024;
const MAX_MESSAGES_PER_TRACE = 16;

function hasIds(traceId: string, spanId: string): boolean {
  return traceId !== INVALID_TRACEID && spanId !== INVALID_SPANID;
}

/** Notes `error` as recorded in `traceId`. Returns whether it already was (propagation). */
function note(error: unknown, traceId: string, message: unknown): boolean {
  let seen = false;
  if (
    error !== null &&
    (typeof error === "object" || typeof error === "function")
  ) {
    const traces = recorded.get(error);
    if (traces === undefined) recorded.set(error, [traceId]);
    else if (traces.includes(traceId)) seen = true;
    else {
      traces.push(traceId);
      if (traces.length > MAX_TRACES_PER_ERROR) traces.shift();
    }
  }
  if (typeof message === "string" && message !== "") {
    let list = messages.get(traceId);
    if (list === undefined) {
      if (messages.size >= MAX_MESSAGE_TRACES) {
        const oldest = messages.keys().next();
        if (!oldest.done) messages.delete(oldest.value);
      }
      list = [];
      messages.set(traceId, list);
    }
    if (!list.includes(message)) {
      list.push(message);
      if (list.length > MAX_MESSAGES_PER_TRACE) list.shift();
    }
  }
  return seen;
}

function messageSeen(traceId: string, message: unknown): boolean {
  return (
    typeof message === "string" &&
    message !== "" &&
    messages.get(traceId)?.includes(message) === true
  );
}

/** For tests: forget what was recorded. */
export function resetRecordedForTests(): void {
  messages.clear();
}

export interface ExceptionEventOptions {
  /** `exception.escaped`; unset unless given (recordError sets `false`). */
  readonly escaped?: boolean;
  /** Extra event attributes (recordError's); never override `exception.*` or `nestrix.exception.*`. */
  readonly attributes?: unknown;
  /**
   * The error reached Nestrix as its message only: it is propagation when that message was already
   * recorded in this trace.
   */
  readonly byMessage?: boolean;
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
  const sc = span.spanContext();
  let propagated = false;
  if (hasIds(sc.traceId, sc.spanId)) {
    const message = attributes[ATTR_EXCEPTION_MESSAGE];
    const byMessage =
      options?.byMessage === true && messageSeen(sc.traceId, message);
    propagated = note(error, sc.traceId, message) || byMessage;
  }
  const expected = isExpectedException(error);
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
