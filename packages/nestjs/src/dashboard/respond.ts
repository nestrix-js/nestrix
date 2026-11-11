/**
 * Writing a dashboard response (architecture §4.6 "Handlers" and "Assets", spike P0-S5 Q5/Q6).
 *
 * Every dashboard response is written to the raw Node `ServerResponse`, never through
 * `httpAdapter.reply` (JSON-encodes a `Buffer` on Express) or `httpAdapter.end` (drops headers
 * on Fastify), and never through Fastify's `reply.send()` (`@fastify/cors` with
 * `hook: 'preSerialization'` runs after the handler and re-adds its allow headers). On Fastify
 * the reply is hijacked first, so Fastify leaves the raw response to us.
 *
 * Before writing, every `Access-Control-*` header a host layer already set is removed, and the
 * full header set of the backlog's "Public API" is set, on every response: success, denial,
 * the 403 page, the 303 of the token exchange, and the 500 of a failed handler. The one exception
 * is a denied request (`minimal`): a bare 404 with `Cache-Control` and `nosniff` only. A handler's
 * `setHeader` replaces a host value of the same name on every adapter (P0-S5 Q4).
 */

/** The dashboard's Content-Security-Policy (backlog P2, "Public API"; confirmed by P2-02). */
export const DASHBOARD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";

/** `Cache-Control` of hashed assets. Everything else is `no-store`. */
export const IMMUTABLE = "public, max-age=31536000, immutable";
export const NO_STORE = "no-store";

/** Headers on every dashboard response, `Cache-Control` aside. Lower-case names. */
export const BASE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy": DASHBOARD_CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
});

export const JSON_TYPE = "application/json; charset=utf-8";
export const HTML_TYPE = "text/html; charset=utf-8";

/** The parts of a raw `ServerResponse` the dashboard uses. */
export interface RawResponseLike {
  statusCode: number;
  readonly headersSent?: boolean;
  readonly writableEnded?: boolean;
  readonly destroyed?: boolean;
  setHeader(name: string, value: string | string[]): unknown;
  removeHeader(name: string): void;
  getHeaderNames(): string[];
  end(body?: Buffer | string): unknown;
  destroy?(error?: Error): unknown;
}

/** A response to write: status, `Content-Type` (none for an empty body), body and extras. */
export interface DashboardResponse {
  readonly status: number;
  readonly contentType?: string | undefined;
  readonly cacheControl?: string | undefined;
  readonly body?: Buffer | string | undefined;
  /** Extra headers (`Location`, `Set-Cookie`). Lower-case names. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /**
   * A denied request (`Deny404`): empty body and only `Cache-Control: no-store` and
   * `X-Content-Type-Options: nosniff`, so the answer carries no dashboard fingerprint.
   */
  readonly minimal?: boolean | undefined;
}

/**
 * On Fastify, tells it the handler writes the raw response itself (`reply.hijack()`), so neither
 * `reply.send()` nor Fastify's `onSend`/`preSerialization` hooks (where `@fastify/cors` can
 * re-add allow headers) run. Express and platform-node responses have no `hijack`: a no-op.
 */
export function takeOver(response: unknown): void {
  if (response === null || typeof response !== "object") return;
  const reply = response as { hijack?: unknown; sent?: unknown };
  if (typeof reply.hijack === "function" && reply.sent !== true) {
    (reply.hijack as () => void).call(response);
  }
}

/** `res.raw ?? res`: Fastify's raw `ServerResponse`, or the response itself (Express, platform-node). */
export function rawResponseOf(response: unknown): RawResponseLike | undefined {
  if (response === null || typeof response !== "object") return undefined;
  const inner = (response as { raw?: unknown }).raw;
  const candidate =
    inner !== null &&
    typeof inner === "object" &&
    typeof (inner as { setHeader?: unknown }).setHeader === "function"
      ? inner
      : response;
  const raw = candidate as Partial<RawResponseLike>;
  return typeof raw.setHeader === "function" &&
    typeof raw.removeHeader === "function" &&
    typeof raw.getHeaderNames === "function" &&
    typeof raw.end === "function"
    ? (raw as RawResponseLike)
    : undefined;
}

/** Removes every `Access-Control-*` header already set on the raw response. */
export function stripCors(raw: RawResponseLike): void {
  for (const name of raw.getHeaderNames()) {
    if (name.toLowerCase().startsWith("access-control-"))
      raw.removeHeader(name);
  }
}

/**
 * Writes `response` to `raw`: strips `Access-Control-*`, sets the base headers, `Cache-Control`,
 * `Content-Type`, `Content-Length` and extras, then `end(body)`. Does nothing when the response
 * already went out (headers sent, ended or destroyed: the client may have gone away while an
 * access check was pending). Throws only what Node's own `setHeader`/`end` throw; callers guard.
 */
export function writeResponse(
  raw: RawResponseLike,
  response: DashboardResponse,
): void {
  if (raw.headersSent === true || raw.writableEnded === true) return;
  if (raw.destroyed === true) return;
  stripCors(raw);
  raw.statusCode = response.status;
  if (response.minimal === true) {
    raw.setHeader("cache-control", NO_STORE);
    raw.setHeader("x-content-type-options", "nosniff");
    raw.end("");
    return;
  }
  for (const [name, value] of Object.entries(BASE_HEADERS)) {
    raw.setHeader(name, value);
  }
  raw.setHeader("cache-control", response.cacheControl ?? NO_STORE);
  const body = response.body ?? "";
  if (response.contentType !== undefined) {
    raw.setHeader("content-type", response.contentType);
  } else {
    raw.removeHeader("content-type");
  }
  raw.setHeader(
    "content-length",
    String(typeof body === "string" ? Buffer.byteLength(body) : body.length),
  );
  if (response.headers) {
    for (const [name, value] of Object.entries(response.headers)) {
      raw.setHeader(name, value);
    }
  }
  raw.end(body);
}

/**
 * The last resort after a handler failed: a `500` through the same raw path, with the full
 * header set. If even that fails (or the headers already went out), the socket is destroyed so
 * the client is not left waiting. Never throws.
 */
export function writeFailure(
  raw: RawResponseLike | undefined,
  body: DashboardResponse,
): void {
  if (!raw) return;
  try {
    if (raw.headersSent === true) {
      if (raw.writableEnded !== true) raw.destroy?.();
      return;
    }
    writeResponse(raw, body);
  } catch {
    try {
      if (raw.headersSent !== true && raw.writableEnded !== true) {
        raw.statusCode = 500;
        raw.end();
      } else if (raw.writableEnded !== true) {
        raw.destroy?.();
      }
    } catch {
      try {
        raw.destroy?.();
      } catch {
        // Nothing more can be done for this response.
      }
    }
  }
}
