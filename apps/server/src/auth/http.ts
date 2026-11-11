/**
 * Request reading and response writing shared by the admin login and the UI (backlog P5-04).
 *
 * Everything here reads the raw Node request (`socket`, `headers`, `rawHeaders`), never `req.ip`
 * or `req.hostname`, which follow client-supplied forwarding headers when a proxy is trusted.
 * Responses are written to the raw `ServerResponse` with the full security header set, after
 * removing any `Access-Control-*` header: the server never emits CORS headers.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/** The dashboard's CSP (architecture §4.7): the UI and the query API. */
export const UI_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";

/** The login and 503 pages: no script at all, one same-origin stylesheet, the form posts to itself. */
export const LOGIN_CSP =
  "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const NO_STORE = "no-store";
export const HTML_TYPE = "text/html; charset=utf-8";
export const JSON_TYPE = "application/json; charset=utf-8";
export const TEXT_TYPE = "text/plain; charset=utf-8";

/** Headers on every UI, query-API and login response, CSP and `Cache-Control` aside. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze(
  {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex",
    "cross-origin-resource-policy": "same-origin",
  },
);

/** Headers whose presence, with any value, means the request was forwarded by a proxy. */
export const FORWARDING_HEADERS = Object.freeze([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "via",
] as const);

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const LOOPBACK_HOST = new RegExp(
  `^(?:localhost|127\\.${OCTET}\\.${OCTET}\\.${OCTET}|\\[::1\\])(?::(\\d{1,5}))?$`,
  "i",
);
/** A `Host` value with only the characters a host name, IPv4, bracketed IPv6 and port use. */
const HOST_CHARS = /^[A-Za-z0-9.\-:[\]]{1,255}$/;

/** The path of a request target, query string removed. `originalUrl` survives Express mounts. */
export function pathnameOf(req: IncomingMessage): string {
  const target =
    (req as { originalUrl?: unknown }).originalUrl ?? req.url ?? "";
  return typeof target === "string" ? target.split("?", 1)[0] : "";
}

/**
 * Whether the browser says the request comes from another site (`Sec-Fetch-Site: cross-site`).
 * Case-insensitive; with several values, any `cross-site` counts. An unreadable header counts.
 */
export function isCrossSite(req: IncomingMessage): boolean {
  try {
    const value = req.headers["sec-fetch-site"];
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (typeof v !== "string") continue;
      for (const part of v.split(",")) {
        if (part.trim().toLowerCase() === "cross-site") return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/** Number of `Host` lines on the wire (Node keeps only the first in `headers`). */
function hostLineCount(req: IncomingMessage): number {
  let count = 0;
  const raw = req.rawHeaders;
  if (!Array.isArray(raw)) return 0;
  for (let i = 0; i < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() === "host") count++;
  }
  return count;
}

/** The single `Host` header, or `undefined` when it is missing, repeated or malformed. */
export function singleHost(req: IncomingMessage): string | undefined {
  const host = req.headers.host;
  if (typeof host !== "string" || !HOST_CHARS.test(host)) return undefined;
  if (hostLineCount(req) !== 1) return undefined;
  return host;
}

/**
 * Whether `Origin` names this server as the request addressed it: one `Origin` header, in its
 * serialized form (`http(s)://host[:port]`, no path, no userinfo), whose host and port equal the
 * single `Host` header's (default ports normalized for the origin's scheme). The scheme itself is
 * not compared with the connection, so a TLS-terminating proxy that keeps `Host` works. A missing
 * `Origin`, `Origin: null` or anything unparseable is a mismatch. Never throws.
 */
export function originMatchesHost(req: IncomingMessage): boolean {
  try {
    const origin = req.headers.origin;
    if (typeof origin !== "string") return false;
    const host = singleHost(req);
    if (host === undefined) return false;
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    // The exact serialized form browsers send: no path, query, userinfo or default port.
    if (url.origin !== origin) return false;
    const addressed = new URL(`${url.protocol}//${host}`);
    if (addressed.username !== "" || addressed.password !== "") return false;
    return addressed.host === url.host && addressed.pathname === "/";
  } catch {
    return false;
  }
}

export function isLoopbackHost(host: unknown): boolean {
  if (typeof host !== "string") return false;
  const match = LOOPBACK_HOST.exec(host);
  if (!match) return false;
  const port = match[1];
  return port === undefined || Number(port) <= 65535;
}

/**
 * A plain-HTTP request addressed to a loopback host and not forwarded: the only case where the
 * session cookie is set without `Secure` (backlog P5-04). Decided from what the browser addressed
 * (`Host`), not the socket peer: in Docker the peer of a browser on the host is the bridge
 * gateway, not loopback, while the browser still talks to `http://localhost`. Any forwarding
 * header, a TLS socket or a non-loopback `Host` means `Secure`.
 */
export function isLoopbackPlainHttp(req: IncomingMessage): boolean {
  try {
    if ((req.socket as { encrypted?: unknown } | null)?.encrypted === true)
      return false;
    if (!isLoopbackHost(singleHost(req))) return false;
    for (const name of FORWARDING_HEADERS) {
      if (req.headers[name] !== undefined) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Every value of cookie `name` in the `Cookie` header(s). Pairs split on `;`, names compared
 * exactly, surrounding whitespace and one pair of double quotes removed. Never throws.
 */
export function getCookieValues(header: unknown, name: string): string[] {
  const out: string[] = [];
  try {
    const text = Array.isArray(header)
      ? header.filter((h) => typeof h === "string").join("; ")
      : header;
    if (typeof text !== "string" || text.length === 0) return out;
    for (const pair of text.split(";")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      if (pair.slice(0, eq).trim() !== name) continue;
      let value = pair.slice(eq + 1).trim();
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      out.push(value);
    }
  } catch {
    return [];
  }
  return out;
}

/** A response to write to the raw `ServerResponse`. */
export interface RawResponse {
  readonly status: number;
  readonly csp: string;
  readonly contentType?: string | undefined;
  readonly cacheControl?: string | undefined;
  readonly body?: Buffer | string | undefined;
  /** Extra headers (`location`, `set-cookie`, `retry-after`). Lower-case names. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** Removes every `Access-Control-*` header already set. */
export function stripCors(res: ServerResponse): void {
  for (const name of res.getHeaderNames()) {
    if (name.toLowerCase().startsWith("access-control-"))
      res.removeHeader(name);
  }
}

function isCorsName(name: unknown): boolean {
  return (
    typeof name === "string" && name.toLowerCase().startsWith("access-control-")
  );
}

/**
 * Makes `res` drop every `Access-Control-*` header when its head is written, whoever set it
 * (a later controller's `@Header()`, a CORS layer, headers passed to `writeHead`). Wraps this
 * one response's own `writeHead`, which Node's implicit header path also calls. The wrapper
 * never throws on its own account: a failure to strip leaves the original call to proceed.
 */
export function suppressCorsHeaders(res: ServerResponse): void {
  const original = res.writeHead;
  if ((original as { nestrixNoCors?: boolean }).nestrixNoCors) return;
  const wrapped = function (
    this: ServerResponse,
    ...args: unknown[]
  ): ServerResponse {
    try {
      stripCors(res);
      for (let i = 1; i < args.length; i++) {
        const headers = args[i];
        if (Array.isArray(headers)) {
          // Flat [name, value, ...] or [[name, value], ...].
          if (headers.length > 0 && Array.isArray(headers[0])) {
            args[i] = headers.filter(
              (pair) => !isCorsName((pair as unknown[])[0]),
            );
          } else {
            const kept: unknown[] = [];
            for (let j = 0; j + 1 < headers.length; j += 2) {
              if (!isCorsName(headers[j]))
                kept.push(headers[j], headers[j + 1]);
            }
            args[i] = kept;
          }
        } else if (headers !== null && typeof headers === "object") {
          const copy: Record<string, unknown> = {};
          for (const [name, value] of Object.entries(headers)) {
            if (!isCorsName(name)) copy[name] = value;
          }
          args[i] = copy;
        }
      }
    } catch {
      // Leave the call as it was.
    }
    return (original as (...a: unknown[]) => ServerResponse).apply(this, args);
  };
  (wrapped as { nestrixNoCors?: boolean }).nestrixNoCors = true;
  res.writeHead = wrapped as ServerResponse["writeHead"];
}

/** Sets the security headers that every non-ingest response carries (the middleware's default). */
export function setSecurityHeaders(res: ServerResponse, csp: string): void {
  stripCors(res);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
  res.setHeader("content-security-policy", csp);
  res.setHeader("cache-control", NO_STORE);
}

/**
 * Writes `response` and ends it. Does nothing once headers went out or the socket is gone.
 * Never throws: a failure destroys the socket rather than leaving the client waiting.
 */
export function writeRaw(res: ServerResponse, response: RawResponse): void {
  try {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    setSecurityHeaders(res, response.csp);
    res.statusCode = response.status;
    res.setHeader("cache-control", response.cacheControl ?? NO_STORE);
    const body = response.body ?? "";
    if (response.contentType !== undefined) {
      res.setHeader("content-type", response.contentType);
    } else {
      res.removeHeader("content-type");
    }
    res.setHeader(
      "content-length",
      String(typeof body === "string" ? Buffer.byteLength(body) : body.length),
    );
    if (response.headers) {
      for (const [name, value] of Object.entries(response.headers)) {
        res.setHeader(name, value);
      }
    }
    res.end(body);
  } catch {
    try {
      if (!res.headersSent && !res.writableEnded) {
        res.statusCode = 500;
        res.end();
      } else if (!res.writableEnded) {
        res.destroy();
      }
    } catch {
      try {
        res.destroy();
      } catch {
        // Nothing more can be done for this response.
      }
    }
  }
}

/** A query-API error body: the protocol's `ApiError` shape. */
export function apiErrorBody(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}
