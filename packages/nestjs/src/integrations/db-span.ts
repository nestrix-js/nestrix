/**
 * What every database and cache span shares (backlog P3-01, "Database span shape"): the current
 * semantic-convention attributes, `CLIENT` kind, the name rule, error recording, and the
 * suppress-tracing rule. Imports `@opentelemetry/api` only (AGENTS.md rule 5); the tracer is
 * obtained at use time.
 *
 * Bind parameters are never recorded (rule 7): nothing here takes them.
 */
import {
  type Attributes,
  type Context,
  isSpanContextValid,
  type Span,
  SpanKind,
  type TimeInput,
  trace,
} from "@opentelemetry/api";
import {
  ATTR_DB_COLLECTION_NAME,
  ATTR_DB_NAMESPACE,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_SYSTEM_NAME,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
} from "@opentelemetry/semantic-conventions";
import {
  recordClientError,
  SUPPRESS_TRACING_KEY,
  TRACER_NAME,
} from "../outbound/rules.js";
import { endNestrixSpan, startNestrixSpan } from "../trace-limit.js";

export type DbSystem = "postgresql" | "mysql" | "redis";

/** What a driver knows about one statement or command, already sanitised. */
export interface DbCall {
  readonly system: DbSystem;
  /** Sanitised statement text, or the Redis command and key. */
  readonly text: string | undefined;
  readonly operation: string | undefined;
  /** Name target (`db.collection.name`) when cheaply and unambiguously known. */
  readonly target: string | undefined;
  readonly namespace: string | undefined;
  readonly address: string | undefined;
  readonly port: number | undefined;
}

/** `true` when `ctx` carries OpenTelemetry's suppress-tracing key (an exporter's own work). */
export function isSuppressed(ctx: Context): boolean {
  return ctx.getValue(SUPPRESS_TRACING_KEY) === true;
}

/** `true` when `ctx` has an active span with a valid span context. */
export function hasActiveSpan(ctx: Context): boolean {
  const span = trace.getSpan(ctx);
  return span !== undefined && isSpanContextValid(span.spanContext());
}

/** `db.operation.name` plus the target when known, else the operation, else the system. */
export function dbSpanName(call: DbCall): string {
  if (call.operation !== undefined) {
    return call.target === undefined
      ? call.operation
      : `${call.operation} ${call.target}`;
  }
  return call.system;
}

export function dbAttributes(call: DbCall): Attributes {
  const attributes: Attributes = { [ATTR_DB_SYSTEM_NAME]: call.system };
  if (call.text !== undefined) attributes[ATTR_DB_QUERY_TEXT] = call.text;
  if (call.operation !== undefined)
    attributes[ATTR_DB_OPERATION_NAME] = call.operation;
  if (call.target !== undefined)
    attributes[ATTR_DB_COLLECTION_NAME] = call.target;
  if (call.namespace !== undefined && call.namespace !== "")
    attributes[ATTR_DB_NAMESPACE] = call.namespace;
  if (call.address !== undefined && call.address !== "")
    attributes[ATTR_SERVER_ADDRESS] = call.address;
  if (call.port !== undefined && Number.isFinite(call.port))
    attributes[ATTR_SERVER_PORT] = call.port;
  return attributes;
}

/** Starts a `CLIENT` span for `call` under `parent`. */
export function startDbSpan(
  call: DbCall,
  parent: Context,
  startTime?: TimeInput,
): Span {
  return startNestrixSpan(
    trace.getTracer(TRACER_NAME),
    dbSpanName(call),
    {
      kind: SpanKind.CLIENT,
      attributes: dbAttributes(call),
      ...(startTime === undefined ? {} : { startTime }),
    },
    parent,
  );
}

/** Ends `span`, first recording `error` (exception event, error status, `error.type`) if any. */
export function endDbSpan(span: Span, error?: unknown): void {
  if (error !== undefined && error !== null) recordClientError(span, error);
  endNestrixSpan(span);
}

/** A port number from a string or number, else `undefined`. */
export function toPort(value: unknown): number | undefined {
  const port = typeof value === "string" ? Number(value) : value;
  return typeof port === "number" && Number.isInteger(port) && port > 0
    ? port
    : undefined;
}

/** A string from a string or finite number (Redis database index), else `undefined`. */
export function toText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Fault injection (tests only; not exported from the package entry point)
// ---------------------------------------------------------------------------------------------

let faultInjector: ((site: string) => void) | undefined;

/** Internal, for tests: `fn` runs at the start of every guarded integration body and may throw. */
export function setIntegrationFaultForTests(
  fn: ((site: string) => void) | undefined,
): void {
  faultInjector = fn;
}

/** Called first inside each guarded body. */
export function fault(site: string): void {
  if (faultInjector !== undefined) faultInjector(site);
}
