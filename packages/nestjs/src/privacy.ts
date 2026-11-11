/**
 * Privacy helpers: what leaves the host application in span attributes (architecture §4.8,
 * AGENTS.md rule 7). Pure functions, no I/O, no state beyond a cache. Used by the HTTP server
 * span (P1-06) and the outbound subscribers (P1-08, P1-09).
 *
 * Rules every function here follows:
 * - Never throw, whatever the input. Callers still wrap their hook bodies (rule 1), but these
 *   helpers are written so that malformed input degrades to "redact more", never to "leak".
 * - When in doubt, redact. Where the input is ambiguous the less revealing reading wins.
 * - Fragments (`#...`) are never emitted.
 */
import {
  ATTR_HTTP_REQUEST_HEADER,
  ATTR_HTTP_RESPONSE_HEADER,
} from "@opentelemetry/semantic-conventions";

/** The value that replaces anything redacted. */
export const REDACTED = "REDACTED";

/** Request headers recorded by default. `user-agent` is not here: it goes to `user_agent.original`. */
export const DEFAULT_REQUEST_HEADERS: readonly string[] = Object.freeze([
  "content-type",
  "content-length",
  "x-request-id",
]);

/** Response headers recorded by default. */
export const DEFAULT_RESPONSE_HEADERS: readonly string[] = Object.freeze([
  "content-type",
  "content-length",
]);

/**
 * Headers whose value is replaced by `REDACTED` even when the user lists them in the allowlist.
 * Lowercase.
 */
export const ALWAYS_REDACTED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

/**
 * Query-string keys whose values are replaced by `REDACTED`, compared case-insensitively.
 * The first four are the HTTP semantic conventions' own list. Lowercase.
 */
export const DEFAULT_REDACTED_QUERY_KEYS: readonly string[] = Object.freeze([
  "awsaccesskeyid",
  "signature",
  "sig",
  "x-goog-signature",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apikey",
  "key",
  "password",
  "passwd",
  "secret",
  "client_secret",
  "code",
  "session",
  "sessionid",
  "jwt",
  "auth",
  "authorization",
]);

/** Attribute-name prefix for request headers: `http.request.header.`. */
export const REQUEST_HEADER_PREFIX = ATTR_HTTP_REQUEST_HEADER(
  "",
) as "http.request.header.";
/** Attribute-name prefix for response headers: `http.response.header.`. */
export const RESPONSE_HEADER_PREFIX = ATTR_HTTP_RESPONSE_HEADER(
  "",
) as "http.response.header.";

export type HeaderAttributePrefix =
  | typeof REQUEST_HEADER_PREFIX
  | typeof RESPONSE_HEADER_PREFIX;

/**
 * Header containers accepted by {@link headerAttributes}:
 * - a Node header object (`IncomingHttpHeaders`, `OutgoingHttpHeaders`; keys of any case);
 * - undici's flat array `[name, value, name, value, ...]` (strings or Buffers);
 * - an array of `[name, value]` pairs.
 *
 * Declared structurally so this file needs no `@types/node`.
 */
export type HeaderValue =
  | string
  | number
  | readonly (string | number | Uint8Array)[]
  | Uint8Array
  | undefined
  | null;
export type HeadersInput =
  | { readonly [name: string]: HeaderValue }
  | ReadonlyArray<
      string | Uint8Array | readonly (string | Uint8Array)[] | HeaderValue
    >;

function normaliseNames(
  ...lists: Array<readonly string[] | undefined>
): Set<string> {
  const out = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const name of list) {
      if (typeof name !== "string") continue;
      const n = name.trim().toLowerCase();
      if (n !== "") out.add(n);
    }
  }
  return out;
}

/**
 * Defaults plus the user's additions (which add, never replace), lowercased and trimmed.
 * Non-string and empty entries are ignored.
 */
export function buildHeaderAllowlist(
  defaults: readonly string[],
  extra?: readonly string[],
): ReadonlySet<string> {
  return normaliseNames(defaults, extra);
}

/** {@link DEFAULT_REDACTED_QUERY_KEYS} plus the user's additions, lowercased and trimmed. */
export function buildRedactedQueryKeys(
  extra?: readonly string[],
): ReadonlySet<string> {
  return normaliseNames(DEFAULT_REDACTED_QUERY_KEYS, extra);
}

const decoder = new TextDecoder("utf-8");

function valueToStrings(value: HeaderValue): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number") return [String(value)];
  if (value instanceof Uint8Array) return [decoder.decode(value)];
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const v of value as readonly unknown[]) {
      if (typeof v === "string") out.push(v);
      else if (typeof v === "number") out.push(String(v));
      else if (v instanceof Uint8Array) out.push(decoder.decode(v));
    }
    return out;
  }
  return [];
}

function nameToString(name: unknown): string | undefined {
  if (typeof name === "string") return name;
  if (name instanceof Uint8Array) return decoder.decode(name);
  return undefined;
}

/** Yields `[name, value]` for every container shape. */
function* iterateHeaders(
  headers: HeadersInput,
): Generator<[string, HeaderValue]> {
  if (Array.isArray(headers)) {
    const list = headers as readonly unknown[];
    let i = 0;
    while (i < list.length) {
      const item = list[i];
      if (Array.isArray(item)) {
        // A `[name, value]` pair.
        const name = nameToString(item[0]);
        if (name !== undefined) yield [name, item[1] as HeaderValue];
        i += 1;
      } else {
        // Flat `name, value` entries. A trailing name with no value is dropped.
        const name = nameToString(item);
        if (name !== undefined && i + 1 < list.length)
          yield [name, list[i + 1] as HeaderValue];
        i += 2;
      }
    }
    return;
  }
  if (headers !== null && typeof headers === "object") {
    for (const name of Object.keys(headers)) {
      yield [name, (headers as Record<string, HeaderValue>)[name]];
    }
  }
}

/**
 * Picks the allowlisted headers and returns them as span attributes, `prefix + lowercase name`
 * mapped to a string array (the conventions' shape for headers, also for single values).
 *
 * - `allowlist` holds lowercase names; a name not in it is dropped. A set built by hand with
 *   uppercase entries therefore drops headers rather than leaking them.
 * - Names in {@link ALWAYS_REDACTED_HEADERS} that are allowlisted yield `["REDACTED"]` (one
 *   element however many values there were; the count is not recorded either).
 * - A name that appears more than once (different case, or repeated in an array) is merged in
 *   order. A header whose values are all unusable (undefined, wrong type) is omitted.
 * - Buffers are decoded as UTF-8. Never throws; a malformed container yields what could be read.
 */
export function headerAttributes(
  headers: HeadersInput | null | undefined,
  allowlist: ReadonlySet<string>,
  prefix: HeaderAttributePrefix,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  try {
    if (headers === null || headers === undefined) return out;
    for (const [rawName, rawValue] of iterateHeaders(headers)) {
      const name = rawName.toLowerCase();
      if (name === "__proto__" || !allowlist.has(name)) continue;
      const values = valueToStrings(rawValue);
      if (values.length === 0) continue;
      const key = prefix + name;
      const shown = ALWAYS_REDACTED_HEADERS.has(name) ? [REDACTED] : values;
      const existing = Object.hasOwn(out, key) ? out[key] : undefined;
      if (existing === undefined) out[key] = shown;
      else if (!ALWAYS_REDACTED_HEADERS.has(name)) existing.push(...shown);
    }
  } catch {
    // Fail closed for the rest: return what was collected so far.
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Query strings
// ---------------------------------------------------------------------------------------------

/** Caches the lowercased form of a key set the caller passed in, so a hand-built set cannot fail open. */
const normalisedKeySets = new WeakMap<
  ReadonlySet<string>,
  ReadonlySet<string>
>();

function normalisedKeys(keys: ReadonlySet<string>): ReadonlySet<string> {
  let n = normalisedKeySets.get(keys);
  if (n === undefined) {
    const lowered = new Set<string>();
    for (const k of keys)
      if (typeof k === "string") lowered.add(k.trim().toLowerCase());
    n = lowered;
    normalisedKeySets.set(keys, n);
  }
  return n;
}

/** Decodes every well-formed `%XX` (as one byte, Latin-1) and leaves malformed escapes alone. */
function lenientDecode(s: string): string {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

const MALFORMED_ESCAPE = /%(?![0-9a-fA-F]{2})/;

function decodeOnce(s: string): string {
  // Most keys have nothing to decode.
  if (!s.includes("%") && !s.includes("+")) return s;
  const plusAsSpace = s.replace(/\+/g, " ");
  // A malformed escape would throw in `decodeURIComponent`; throwing is slow, so go straight to
  // the fallback. Bad UTF-8 in well-formed escapes (`%E0%A4%41`) still throws and lands there too.
  if (!MALFORMED_ESCAPE.test(plusAsSpace)) {
    try {
      return decodeURIComponent(plusAsSpace);
    } catch {
      // fall through
    }
  }
  // Malformed encoding. Decode what is well-formed instead of giving up, so `api%5Fkey&x=%zz`
  // style tricks cannot hide a listed key.
  return lenientDecode(plusAsSpace);
}

const MAX_DECODE_ROUNDS = 3;

/**
 * Every reading of a raw key that might equal a listed key: the raw text, then up to three rounds
 * of percent-decoding (so a double-encoded `api%255Fkey` is caught too), each lowercased and
 * trimmed, plus the parts of bracket notation (`user[password]`, `token[]`, `a[b][code]`),
 * because Express and other parsers turn those into nested values.
 */
function keyReadings(rawKey: string): Set<string> {
  const readings = new Set<string>();
  let current = rawKey;
  const add = (s: string): void => {
    const lower = s.trim().toLowerCase();
    readings.add(lower);
    if (lower.includes("[")) {
      for (const part of lower.split(/[[\]]/)) {
        const p = part.trim();
        if (p !== "") readings.add(p);
      }
    }
  };
  add(current);
  for (let i = 0; i < MAX_DECODE_ROUNDS; i++) {
    const next = decodeOnce(current);
    if (next === current) break;
    add(next);
    current = next;
  }
  return readings;
}

function isRedactedKey(rawKey: string, keys: ReadonlySet<string>): boolean {
  for (const reading of keyReadings(rawKey)) {
    if (keys.has(reading)) return true;
  }
  return false;
}

/**
 * Replaces the value of every listed key in a raw query string with `REDACTED`, keeping order,
 * keys, separators and repeated keys. Operates on the raw text: nothing is parsed into a map and
 * re-serialised, so encoding of the kept parts is untouched.
 *
 * Decisions on ambiguous input:
 * - `keys` is compared case-insensitively against the percent-decoded key (`api%5Fkey`,
 *   `API_KEY`, `api+key` is a different key); the set is lowercased defensively.
 * - A segment is split at its first `=`; the value is everything after it, however many `=`.
 * - A listed key with an empty value (`token=`) is still redacted (`token=REDACTED`).
 * - A segment with no `=` (`?token`, `?abc123`) has no key/value shape, so it could be a bare
 *   secret: it becomes `REDACTED` whole, listed or not. Empty segments (`&&`, trailing `&`) are
 *   kept as they are.
 * - Malformed percent-encoding in a key never prevents a match (see {@link keyReadings}); in a
 *   value it is irrelevant, since the value is dropped.
 * - Only `&` separates pairs. `;` does not (WHATWG URL parsing), so `a=1;token=x` is one pair
 *   under key `a`.
 * - One leading `?` is accepted and dropped. Anything from the first `#` is dropped.
 */
export function redactQuery(
  rawQuery: string,
  keys: ReadonlySet<string>,
): string {
  try {
    let query = typeof rawQuery === "string" ? rawQuery : "";
    const hash = query.indexOf("#");
    if (hash !== -1) query = query.slice(0, hash);
    if (query.startsWith("?")) query = query.slice(1);
    if (query === "") return "";
    const lowered = normalisedKeys(keys);
    return query
      .split("&")
      .map((segment) => {
        if (segment === "") return segment;
        const eq = segment.indexOf("=");
        if (eq === -1) return REDACTED;
        const key = segment.slice(0, eq);
        return isRedactedKey(key, lowered) ? `${key}=${REDACTED}` : segment;
      })
      .join("&");
  } catch {
    // Cannot happen with the code above, but a privacy helper must not fail open.
    return REDACTED;
  }
}

const SCHEME_AND_AUTHORITY = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/{2,}[^/?#]*/;
const BARE_AUTHORITY = /^\/{2,}[^/?#]*/;
// Leading whitespace and C0 control characters, which URL parsers strip.
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const LEADING_JUNK = /^[\u0000-\u0020]+/;

/**
 * Splits a request target (`/a/b?x=1#f`) or an absolute URL (`http://user:pw@host/a?x=1#f`) into
 * `url.path` and the redacted `url.query`.
 *
 * - Leading whitespace and C0 control characters are trimmed first (URL parsers do the same).
 * - The fragment is dropped before anything else.
 * - A scheme plus authority (`http://user:pw@host`, any number of slashes after the scheme) or a
 *   bare `//authority` (two or more slashes) is dropped, including any `user:password@`, so credentials in the URL
 *   cannot reach the result. For this detection `\` counts as `/` (browsers treat it so for
 *   `http:\\u:pw@h\x`); the rest of the path is returned unchanged. An empty remaining path
 *   becomes `/`. Consequence: a request target that starts with `//` (`//evil/x`) loses its first
 *   segment as if it were a host.
 * - `query` is absent when there is no `?` or the query is empty. The path is returned as is: the
 *   helper does not redact path segments (secrets in paths are the route template's concern).
 * - Never throws; on an unusable input the path is `""`.
 */
export function splitUrl(
  pathOrUrl: string,
  keys: ReadonlySet<string>,
): { path: string; query?: string } {
  try {
    let rest =
      typeof pathOrUrl === "string" ? pathOrUrl.replace(LEADING_JUNK, "") : "";
    const hash = rest.indexOf("#");
    if (hash !== -1) rest = rest.slice(0, hash);
    const q = rest.indexOf("?");
    const query = q === -1 ? "" : rest.slice(q + 1);
    let path = q === -1 ? rest : rest.slice(0, q);
    // Same length as `path`, so match lengths apply to both.
    const slashed = path.replace(/\\/g, "/");
    const authority =
      SCHEME_AND_AUTHORITY.exec(slashed) ?? BARE_AUTHORITY.exec(slashed);
    if (authority !== null) {
      path = path.slice(authority[0].length);
      if (path === "") path = "/";
    }
    if (q === -1) return { path };
    const redacted = redactQuery(query, keys);
    return redacted === "" ? { path } : { path, query: redacted };
  } catch {
    return { path: "" };
  }
}
