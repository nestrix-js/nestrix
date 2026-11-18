/**
 * Trace attribute names (issue #27, D-102), shared by option resolution and the runtime. No imports,
 * so `resolve-options.ts` can use it without loading the instrumentation.
 */

/** Attribute names `context` and `setTraceAttributes` may set: letters, digits, `_`, `.`, `-`. */
export const TRACE_ATTRIBUTE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
/** Longest string value kept; a longer one is cut (never inside a surrogate pair). */
export const MAX_TRACE_ATTRIBUTE_VALUE_LENGTH = 256;
/** Keys read from one `context` result or one `setTraceAttributes` call; the rest are ignored. */
export const MAX_TRACE_ATTRIBUTES = 32;
/** Keys `contextPropagation.keys` may list. */
export const MAX_PROPAGATED_KEYS = 16;

/**
 * Prefixes owned by Nestrix or by the OpenTelemetry semantic conventions of the spans Nestrix
 * records: a `context` value must not overwrite `http.route` or `nestrix.exception.*`.
 */
const RESERVED_PREFIXES = [
  "nestrix.",
  "http.",
  "url.",
  "exception.",
  "error.",
  "server.",
  "client.",
  "network.",
  "db.",
  "messaging.",
  "rpc.",
  "service.",
  "telemetry.",
  "otel.",
  "code.",
  "user_agent.",
];
/** `user.id` belongs to the `user` option. */
const RESERVED_KEYS = new Set(["user.id"]);

/** Why `key` cannot be a trace attribute name, or `undefined` when it can. */
export function traceAttributeKeyProblem(key: string): string | undefined {
  if (!TRACE_ATTRIBUTE_KEY.test(key)) {
    return "must start with a letter and hold at most 128 letters, digits, '_', '.' or '-'";
  }
  const lower = key.toLowerCase();
  if (RESERVED_KEYS.has(lower)) return "is set by the user option";
  for (const prefix of RESERVED_PREFIXES) {
    if (lower.startsWith(prefix)) return `uses the reserved prefix ${prefix}`;
  }
  return undefined;
}
