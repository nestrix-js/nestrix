/**
 * Which stored spans are error occurrences, and which make their trace "have errors" (issues #22,
 * #23, #25; D-93, D-94). Pure functions. `packages/nestjs/src/store/error-facts.ts` is the embedded
 * copy; keep the two in step. The query SQL in `query/error-sql.ts` applies the same rules.
 *
 * Rules, over a span's status code and its `exception` events:
 * - An event is **propagated** when it carries `nestrix.exception.propagated = true` (Nestrix
 *   recorded the same error object deeper in the trace first) and **expected** when it carries
 *   `nestrix.exception.expected = true` (by default an exception that maps to a status below 500).
 * - The **primary** exception of a span is its first exception event that is neither.
 * - A span is an **error occurrence** when its status is `error` and it has no exception event at
 *   all (a 5xx answered without a throw, a failed client call) or it has a primary exception. A
 *   span whose exceptions are all propagated or expected is not one: its error is counted where it
 *   was first recorded, or not at all.
 * - A span **failed** (it makes its trace `hasErrors`) when its status is `error`, unless every
 *   exception event on it is expected.
 * - Spans from SDKs that do not mark propagation (older Nestrix, other instrumentations): a span
 *   is not an occurrence when one of its direct children is an occurrence with the same primary
 *   exception (same type, message and stack trace); the deepest span keeps it.
 */

export const ATTR_EXCEPTION_PROPAGATED = "nestrix.exception.propagated";
export const ATTR_EXCEPTION_EXPECTED = "nestrix.exception.expected";
const EXCEPTION_EVENT = "exception";

/** The part of a span event these rules read. */
export interface EventLike {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

function marked(event: EventLike, key: string): boolean {
  const value = event.attributes[key];
  return value === true || value === "true";
}

function isException(event: EventLike): boolean {
  return event.name === EXCEPTION_EVENT;
}

/** The first exception event that is neither propagated nor expected. */
export function primaryException<E extends EventLike>(
  events: readonly E[],
): E | undefined {
  for (const e of events) {
    if (
      isException(e) &&
      !marked(e, ATTR_EXCEPTION_PROPAGATED) &&
      !marked(e, ATTR_EXCEPTION_EXPECTED)
    ) {
      return e;
    }
  }
  return undefined;
}

/** Status `error`, and an occurrence by the rules above (the legacy parent rule aside). */
export function isErrorOccurrence(
  statusCode: string,
  events: readonly EventLike[],
): boolean {
  if (statusCode !== "error") return false;
  if (!events.some(isException)) return true;
  return primaryException(events) !== undefined;
}

/** Status `error`, unless every exception event on the span is expected. */
export function isFailedSpan(
  statusCode: string,
  events: readonly EventLike[],
): boolean {
  if (statusCode !== "error") return false;
  let exceptions = 0;
  for (const e of events) {
    if (!isException(e)) continue;
    exceptions++;
    if (!marked(e, ATTR_EXCEPTION_EXPECTED)) return true;
  }
  return exceptions === 0;
}

const IDENTITY = [
  "exception.type",
  "exception.message",
  "exception.stacktrace",
] as const;

/** Same exception for the legacy parent rule: equal type, message and stack trace. */
export function sameException(a: EventLike, b: EventLike): boolean {
  for (const key of IDENTITY) {
    if (a.attributes[key] !== b.attributes[key]) return false;
  }
  return true;
}
