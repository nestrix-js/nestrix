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
  collectHeaderAttributes(headers, allowlist, prefix, out);
  return out;
}

/**
 * {@link headerAttributes} writing into `out` instead of a new object, for a caller that
 * already holds the object it would copy them into (the request hook's attributes). Same
 * rules; never throws; what was collected before a failure stays in `out`. Walks the container
 * in place: no generator and no `[name, value]` pair per header (P2-15).
 */
export function collectHeaderAttributes(
  headers: HeadersInput | null | undefined,
  allowlist: ReadonlySet<string>,
  prefix: HeaderAttributePrefix,
  out: Record<string, unknown>,
): void {
  try {
    if (headers === null || headers === undefined) return;
    if (Array.isArray(headers)) {
      const list = headers as readonly unknown[];
      let i = 0;
      while (i < list.length) {
        const item = list[i];
        if (Array.isArray(item)) {
          // A `[name, value]` pair.
          const name = nameToString(item[0]);
          if (name !== undefined) {
            addHeader(out, name, item[1] as HeaderValue, allowlist, prefix);
          }
          i += 1;
        } else {
          // Flat `name, value` entries. A trailing name with no value is dropped.
          const name = nameToString(item);
          if (name !== undefined && i + 1 < list.length) {
            addHeader(out, name, list[i + 1] as HeaderValue, allowlist, prefix);
          }
          i += 2;
        }
      }
      return;
    }
    if (typeof headers === "object") {
      for (const name of Object.keys(headers)) {
        addHeader(
          out,
          name,
          (headers as Record<string, HeaderValue>)[name],
          allowlist,
          prefix,
        );
      }
    }
  } catch {
    // Fail closed for the rest: what was collected so far stays.
  }
}

function addHeader(
  out: Record<string, unknown>,
  rawName: string,
  rawValue: HeaderValue,
  allowlist: ReadonlySet<string>,
  prefix: HeaderAttributePrefix,
): void {
  const name = rawName.toLowerCase();
  if (name === "__proto__" || !allowlist.has(name)) return;
  const values = valueToStrings(rawValue);
  if (values.length === 0) return;
  const key = prefix + name;
  const shown = ALWAYS_REDACTED_HEADERS.has(name) ? [REDACTED] : values;
  const existing = Object.hasOwn(out, key) ? out[key] : undefined;
  if (existing === undefined) out[key] = shown;
  else if (!ALWAYS_REDACTED_HEADERS.has(name))
    (existing as string[]).push(...shown);
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

/** The subset of `RedactableSpan` (options.ts) that `scrubSpanAttributes` reads and writes. */
interface ScrubbableSpan {
  attributes: Record<string, unknown>;
  readonly events?: ReadonlyArray<{ attributes: Record<string, unknown> }>;
}

const USERINFO = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#]*@/;

/**
 * Nestrix's own redaction step for every span the Nestrix-owned pipeline exports and the
 * dashboard store keeps, including spans from other instrumentations (architecture §4.8, D-37).
 * Applies one rule to the span's attributes and to each event's attributes (D-111: an event
 * can carry a header or a URL too, from `recordError(error, attributes)`, `span.addEvent` or
 * another instrumentation). Rewrites in place:
 * - `url.query`: values of listed keys become `REDACTED`;
 * - `url.full`: the same for its query, the fragment dropped, userinfo replaced by
 *   `REDACTED:REDACTED` as the semantic conventions ask;
 * - `http.request.header.*` / `http.response.header.*` for the always-redacted headers: `["REDACTED"]`.
 *
 * Fails closed: an attribute it cannot read safely is deleted; an event whose attribute map
 * cannot be walked gets an empty map. It throws only when even that is impossible (or the span's
 * own map cannot be walked); both callers (`otel/redaction.ts`) then drop the whole span.
 */
export function scrubSpanAttributes(
  span: ScrubbableSpan,
  keys: ReadonlySet<string>,
): void {
  scrubAttributeMap(span.attributes, keys);
  const events = span.events;
  if (events === undefined) return;
  for (const event of events) {
    try {
      scrubAttributeMap(event.attributes, keys);
    } catch {
      // Neutralise rather than let an unscrubbed map through. If this assignment throws as
      // well, the error reaches `redactSpan`, which fails (drops) the span.
      event.attributes = {};
    }
  }
}

/** The rule of {@link scrubSpanAttributes} on one attribute map. Throws only if the map cannot be walked. */
function scrubAttributeMap(
  attributes: Record<string, unknown>,
  keys: ReadonlySet<string>,
): void {
  for (const name of Object.keys(attributes)) {
    try {
      const value = attributes[name];
      if (name === "url.query") {
        if (typeof value !== "string") delete attributes[name];
        else attributes[name] = redactQuery(value, keys);
      } else if (name === "url.full") {
        if (typeof value !== "string") {
          delete attributes[name];
          continue;
        }
        let url = value;
        const hash = url.indexOf("#");
        if (hash !== -1) url = url.slice(0, hash);
        url = url.replace(USERINFO, `$1${REDACTED}:${REDACTED}@`);
        const q = url.indexOf("?");
        if (q !== -1) {
          const query = redactQuery(url.slice(q + 1), keys);
          url =
            query === "" ? url.slice(0, q) : `${url.slice(0, q + 1)}${query}`;
        }
        attributes[name] = url;
      } else {
        const header = name.startsWith(REQUEST_HEADER_PREFIX)
          ? name.slice(REQUEST_HEADER_PREFIX.length)
          : name.startsWith(RESPONSE_HEADER_PREFIX)
            ? name.slice(RESPONSE_HEADER_PREFIX.length)
            : undefined;
        if (
          header !== undefined &&
          ALWAYS_REDACTED_HEADERS.has(header.toLowerCase())
        ) {
          attributes[name] = [REDACTED];
        }
      }
    } catch {
      // Throws when the attribute cannot be deleted either: the raw value must not stay, so
      // the caller neutralises the map (an event) or drops the span (`redactSpan`).
      delete attributes[name];
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Path segments (issue #48, D-97)
// ---------------------------------------------------------------------------------------------

/**
 * Route parameter names whose values are written as `REDACTED` in the server span's `url.path`
 * (`http.redactPathParams` adds to them). Compared case-insensitively with the name declared in
 * the route (`:token`). Narrower than {@link DEFAULT_REDACTED_QUERY_KEYS}: `key`, `code` and
 * `auth` name ordinary values in paths too often (`/settings/:key`, `/countries/:code`). Lowercase.
 */
export const DEFAULT_REDACTED_PATH_PARAMS: readonly string[] = Object.freeze([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apikey",
  "password",
  "passwd",
  "secret",
  "client_secret",
  "signature",
  "sig",
  "jwt",
  "session",
  "sessionid",
]);

/** {@link DEFAULT_REDACTED_PATH_PARAMS} plus the user's additions, lowercased and trimmed. */
export function buildRedactedPathParams(
  extra?: readonly string[],
): ReadonlySet<string> {
  return normaliseNames(DEFAULT_REDACTED_PATH_PARAMS, extra);
}

type RouteSegment =
  | { readonly param: false; readonly text: string }
  | { readonly param: true; readonly names: readonly string[] };

interface ParsedRoute {
  /** Every parameter name in the route, lowercased (`:name` and `*name`). */
  readonly names: readonly string[];
  /**
   * The route has syntax whose segments cannot be lined up one to one with the request path:
   * a wildcard, an optional group, a regular-expression parameter or an optional parameter.
   */
  readonly complex: boolean;
  readonly segments: readonly RouteSegment[];
}

// `:name`, `*name`, and path-to-regexp 8's quoted form `:"name"` (escapes kept as written).
const PARAM_NAME = /[:*](?:([A-Za-z_$][\w$]*)|"((?:[^"\\]|\\.)*)")/g;
// `"` too: a quoted name can hold any character, so its segment cannot be read reliably.
const COMPLEX_ROUTE = /[(){}*?+"]/;
const MAX_PARSED_ROUTES = 2048;
const parsedRoutes = new Map<string, ParsedRoute>();

function namesIn(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(PARAM_NAME)) {
    names.push((m[1] ?? m[2] ?? "").toLowerCase());
  }
  return names;
}

/** A path segment as routers compare it: percent-decoded (UTF-8 when well-formed), lowercased. */
function decodeForCompare(segment: string): string {
  if (!segment.includes("%")) return segment.toLowerCase();
  if (!MALFORMED_ESCAPE.test(segment)) {
    try {
      return decodeURIComponent(segment).toLowerCase();
    } catch {
      // Bad UTF-8 in well-formed escapes: fall through.
    }
  }
  return lenientDecode(segment).toLowerCase();
}

function parseRoute(route: string): ParsedRoute {
  const cached = parsedRoutes.get(route);
  if (cached !== undefined) return cached;
  // Nest reports the declared path before its own normalisation: repeated slashes are possible.
  let normalised = route.replace(/\/{2,}/g, "/");
  if (normalised.length > 1 && normalised.endsWith("/")) {
    normalised = normalised.slice(0, -1);
  }
  if (normalised.startsWith("/")) normalised = normalised.slice(1);
  const segments: RouteSegment[] =
    normalised === ""
      ? []
      : normalised
          .split("/")
          .map((text) =>
            text.includes(":")
              ? { param: true, names: namesIn(text) }
              : { param: false, text: decodeForCompare(text) },
          );
  const parsed: ParsedRoute = {
    names: namesIn(route),
    complex: COMPLEX_ROUTE.test(route),
    segments,
  };
  if (parsedRoutes.size >= MAX_PARSED_ROUTES) parsedRoutes.clear();
  parsedRoutes.set(route, parsed);
  return parsed;
}

function anyListed(
  names: readonly string[],
  listed: ReadonlySet<string>,
): boolean {
  for (const name of names) if (listed.has(name)) return true;
  return false;
}

/** Whether `route` declares a parameter whose lowercase name is in `listed`. Never throws. */
export function routeHasListedParam(
  route: string | undefined,
  listed: ReadonlySet<string>,
): boolean {
  if (typeof route !== "string" || listed.size === 0) return false;
  try {
    return anyListed(parseRoute(route).names, listed);
  } catch {
    return true;
  }
}

/**
 * The server span's `url.path` with the values of listed route parameters written as `REDACTED`
 * (`http.redactPathParams`, D-97). `route` is the template Nest reported for the request
 * (`/invitations/:token`); `listed` holds lowercase parameter names.
 *
 * - No route, or a route with no listed parameter: `path` unchanged.
 * - The request path is lined up with the route segment by segment. A segment that holds a listed
 *   parameter is replaced whole (`/files/:token.:ext` gives `/files/REDACTED`). Other segments,
 *   and one trailing slash, are kept as sent.
 * - When the two cannot be lined up exactly (a different number of segments, a static segment
 *   that differs after percent-decoding and lowercasing, an empty segment, a wildcard, an
 *   optional group, an optional or a regular-expression parameter in the route), the route
 *   template itself is returned: it holds no value from the request.
 * - Never throws; on an internal failure, the route template is returned.
 */
export function redactPathParams(
  path: string,
  route: string | undefined,
  listed: ReadonlySet<string>,
): string {
  if (typeof route !== "string" || listed.size === 0) return path;
  try {
    const parsed = parseRoute(route);
    if (!anyListed(parsed.names, listed)) return path;
    if (parsed.complex || typeof path !== "string") return route;
    let p = path;
    let trailing = "";
    if (p.length > 1 && p.endsWith("/")) {
      p = p.slice(0, -1);
      trailing = "/";
    }
    if (!p.startsWith("/")) return route;
    const raw = p === "/" ? [] : p.slice(1).split("/");
    const segments = parsed.segments;
    if (raw.length !== segments.length) return route;
    const out: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] as RouteSegment;
      const value = raw[i] as string;
      if (value === "") return route;
      if (!segment.param) {
        if (decodeForCompare(value) !== segment.text) return route;
        out.push(value);
      } else {
        out.push(anyListed(segment.names, listed) ? REDACTED : value);
      }
    }
    return `/${out.join("/")}${trailing}`;
  } catch {
    return route;
  }
}

/** One compiled `http.redactOutgoingPath` entry. */
export type OutgoingPathRedactor =
  | {
      readonly kind: "pattern";
      /** Lowercased `scheme://host[:port]`, or `undefined` for any origin. */
      readonly origin: string | undefined;
      /** A string must equal the segment; `null` matches any one and keeps it; `true` any one, redacted. */
      readonly segments: ReadonlyArray<string | null | true>;
    }
  | { readonly kind: "regexp"; readonly re: RegExp; readonly global: boolean };

const PATTERN_ORIGIN = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]+)(\/[^?#]*)?$/;

/**
 * Compiles `http.redactOutgoingPath` entries, or returns an error message (naming the entry's
 * position, not its value) for an entry that is not usable, so the options are refused at startup.
 * - A string is a path pattern, `/v1/invitations/:token`, optionally preceded by an origin,
 *   `https://api.example.com/v1/invitations/:token` (scheme, host and port compared
 *   case-insensitively with the recorded `url.full`). Segments are compared exactly; `:name`
 *   matches any one non-empty segment and redacts it; `*` matches any one and keeps it. The
 *   pattern matches the start of the path in whole segments, so it also covers
 *   `/v1/invitations/abc/accept`. It must hold at least one `:name` segment.
 * - A `RegExp` is run on the path (from the first `/` after the host, up to `?`). Each capture
 *   group's text is replaced by `REDACTED`, or the whole match when no group took part; with the
 *   `g` flag every match is, without it the first.
 */
export function compileOutgoingPathRedactors(
  entries: readonly unknown[],
): OutgoingPathRedactor[] | { error: string } {
  const out: OutgoingPathRedactor[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const where = `http.redactOutgoingPath[${i}]`;
    if (entry instanceof RegExp) {
      let flags = entry.flags;
      if (!flags.includes("d")) flags += "d";
      if (!flags.includes("g")) flags += "g";
      out.push({
        kind: "regexp",
        re: new RegExp(entry.source, flags),
        global: entry.flags.includes("g"),
      });
      continue;
    }
    if (typeof entry !== "string") {
      return { error: `${where} must be a string or a RegExp` };
    }
    let origin: string | undefined;
    let path = entry;
    if (!entry.startsWith("/")) {
      const m = PATTERN_ORIGIN.exec(entry);
      if (m === null) {
        return {
          error: `${where} must start with "/" or with an absolute URL's origin`,
        };
      }
      // The recorded `url.full` leaves out the scheme's default port; so does the pattern.
      origin = (m[1] as string)
        .toLowerCase()
        .replace(/^(https:\/\/[^/]*?):443$/, "$1")
        .replace(/^(http:\/\/[^/]*?):80$/, "$1");
      path = m[2] ?? "/";
    }
    if (path.includes("?") || path.includes("#")) {
      return { error: `${where} must not hold a query or a fragment` };
    }
    const parts = path.split("/").slice(1);
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    if (parts.includes("")) {
      // `redactByPattern` never matches an empty segment, so such a pattern would do nothing.
      return { error: `${where} must not hold an empty segment ("//")` };
    }
    const segments = parts.map((s): string | null | true =>
      s === "*" ? null : s.startsWith(":") ? true : s,
    );
    if (!segments.includes(true)) {
      return { error: `${where} must hold at least one ":name" segment` };
    }
    out.push({ kind: "pattern", origin, segments: Object.freeze(segments) });
  }
  return out;
}

const URL_ORIGIN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/;

function redactByPattern(
  path: string,
  segments: ReadonlyArray<string | null | true>,
): string {
  const raw = path.split("/");
  // raw[0] is "" (the path starts with "/").
  if (raw.length - 1 < segments.length) return path;
  for (let i = 0; i < segments.length; i++) {
    const want = segments[i];
    const value = raw[i + 1] as string;
    if (value === "") return path;
    if (typeof want === "string" && want !== value) return path;
  }
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === true) raw[i + 1] = REDACTED;
  }
  return raw.join("/");
}

function redactByRegExp(path: string, re: RegExp, global: boolean): string {
  // Ranges to replace; `re` always carries `d` (group indices) and `g` (lastIndex is honoured).
  const ranges: Array<[number, number]> = [];
  re.lastIndex = 0;
  for (;;) {
    const m = re.exec(path);
    if (m === null) break;
    let groups = 0;
    const indices = m.indices;
    if (indices !== undefined) {
      for (let g = 1; g < indices.length; g++) {
        const r = indices[g];
        if (r === undefined) continue;
        groups++;
        if (r[1] > r[0]) ranges.push([r[0], r[1]]);
      }
    }
    if (groups === 0 && m[0].length > 0) {
      ranges.push([m.index, m.index + m[0].length]);
    }
    if (!global) break;
    if (m[0].length === 0) re.lastIndex++;
  }
  re.lastIndex = 0;
  if (ranges.length === 0) return path;
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [start, end] of ranges) {
    if (end <= at) continue; // nested in a range already replaced
    out += path.slice(at, Math.max(start, at)) + REDACTED;
    at = end;
  }
  return out + path.slice(at);
}

/**
 * Applies the `http.redactOutgoingPath` redactors to a recorded `url.full` (scheme, host, path,
 * already-redacted query). Only the path changes; origin and query are kept. Never throws: when
 * a redactor fails, the whole path becomes `/REDACTED` (fail closed) and `onError` is told.
 */
export function redactOutgoingPath(
  full: string,
  redactors: readonly OutgoingPathRedactor[],
  onError?: (error: unknown) => void,
): string {
  if (redactors.length === 0 || typeof full !== "string") return full;
  let origin = "";
  let query = "";
  try {
    const originMatch = URL_ORIGIN.exec(full);
    origin = originMatch === null ? "" : originMatch[0];
    const afterOrigin = full.slice(origin.length);
    const q = afterOrigin.indexOf("?");
    query = q === -1 ? "" : afterOrigin.slice(q);
    let path = q === -1 ? afterOrigin : afterOrigin.slice(0, q);
    if (!path.startsWith("/")) return full;
    const lowerOrigin = origin.toLowerCase();
    for (const r of redactors) {
      if (r.kind === "pattern") {
        if (r.origin !== undefined && r.origin !== lowerOrigin) continue;
        path = redactByPattern(path, r.segments);
      } else {
        path = redactByRegExp(path, r.re, r.global);
      }
    }
    return `${origin}${path}${query}`;
  } catch (error) {
    try {
      onError?.(error);
    } catch {
      // The caller's counter failed; the URL is still redacted.
    }
    return `${origin}/${REDACTED}${query}`;
  }
}
