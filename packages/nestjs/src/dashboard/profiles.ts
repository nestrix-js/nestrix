/**
 * The profiler routes of the embedded dashboard (P7-02, D-70; architecture §4.6, §4.7). Shapes in
 * `@nestrix-js/protocol` (`profiles.ts`), imported as types only; the two specs below are local
 * copies annotated with the protocol's spec types, so a drifting bound fails `tsc`.
 *
 * `POST <path>/api/v1/profiles` is the dashboard's first state-changing request. After the read
 * rules of §4.7 have admitted it (`checkAccess`, in `mount.ts`), it must also pass, in this order:
 * 1. `Sec-Fetch-Site: same-origin`, exactly one header (a browser sets it; a page cannot);
 * 2. exactly one `Origin`, equal to the request's own origin (scheme and the raw `Host`);
 * 3. `Content-Type: application/json` (a cross-site form or a "simple" `fetch` cannot send it
 *    without a preflight);
 * 4. a `Content-Length` of 1 to 1,024 bytes, no `Transfer-Encoding`;
 * 5. a JSON object with only `durationSeconds` (an integer, 1 to 120).
 * Each refusal is answered before a capture is started, never with CORS headers (the handler
 * strips them, as every dashboard handler does).
 *
 * Nothing here throws to its caller; reading the body never rejects.
 */
import type {
  ProfileConflictError,
  ProfileIdParamsSpec,
  ProfileStartBodySpec,
} from "@nestrix-js/protocol";
import type { Profiler } from "../profiler/profiler.js";
import type { RawRequestLike } from "./access.js";
import { apiError, parseQuery } from "./api.js";
import { type DashboardResponse, JSON_TYPE } from "./respond.js";

export const profileStartSpec: ProfileStartBodySpec = {
  durationSeconds: { kind: "int", min: 1, max: 120, default: 30 },
};

export const profileIdSpec: ProfileIdParamsSpec = {
  id: { kind: "string", maxLength: 16, pattern: "^[0-9a-f]{16}$" },
};

/** Largest accepted start body, bytes. `{"durationSeconds":120}` is 24. */
export const START_BODY_LIMIT = 1024;
/** Reading the body ourselves (no host parser ran) gives up after this long. */
export const BODY_READ_TIMEOUT_MS = 5000;

const ID_PATTERN = new RegExp(profileIdSpec.id.pattern);

function forbidden(message: string): DashboardResponse {
  return apiError(403, "forbidden", message);
}

/** Lower-cased header names as sent, or `undefined` when `rawHeaders` is missing (fakes). */
function rawHeaderNames(raw: RawRequestLike): string[] | undefined {
  const list = raw.rawHeaders;
  if (!Array.isArray(list)) return undefined;
  const names: string[] = [];
  for (let i = 0; i < list.length; i += 2) {
    const name = list[i];
    if (typeof name === "string") names.push(name.toLowerCase());
  }
  return names;
}

/** How many times `name` was sent: from `rawHeaders`, or 0/1 from `headers`. */
function headerCount(
  raw: RawRequestLike,
  names: string[] | undefined,
  name: string,
): number {
  if (names !== undefined) return names.filter((n) => n === name).length;
  return raw.headers?.[name] === undefined ? 0 : 1;
}

function headerText(raw: RawRequestLike, name: string): string | undefined {
  const value = raw.headers?.[name];
  return typeof value === "string" ? value : undefined;
}

function withoutDefaultPort(authority: string, scheme: string): string {
  if (scheme === "http" && authority.endsWith(":80"))
    return authority.slice(0, -3);
  if (scheme === "https" && authority.endsWith(":443"))
    return authority.slice(0, -4);
  return authority;
}

const ORIGIN = /^(https?):\/\/([^/?#@\s\\]+)$/;
const AUTHORITY = /^[^/?#@\s\\]+$/;

/**
 * Whether `origin` (the `Origin` header) names the request's own origin: an `http` or `https`
 * origin whose host and port equal the raw `Host` header (case-insensitive, default ports
 * ignored). On a TLS socket the scheme must be `https`. On a plain socket either scheme is
 * accepted, because behind a TLS-terminating proxy the browser's origin is `https` while Node sees
 * plain HTTP; the host must still match, so such a proxy must forward the original `Host`.
 * `Sec-Fetch-Site: same-origin` (checked first) is what a browser computes from the full origin.
 * Never throws.
 */
export function isOwnOrigin(
  origin: unknown,
  host: unknown,
  encrypted: boolean,
): boolean {
  try {
    if (typeof origin !== "string" || typeof host !== "string") return false;
    const o = ORIGIN.exec(origin.trim().toLowerCase());
    const h = host.trim().toLowerCase();
    if (o === null || !AUTHORITY.test(h)) return false;
    const scheme = o[1] as string;
    if (encrypted && scheme !== "https") return false;
    return (
      withoutDefaultPort(o[2] as string, scheme) ===
      withoutDefaultPort(h, scheme)
    );
  } catch {
    return false;
  }
}

/**
 * Steps 1 to 4 of the module comment, on the raw request. `undefined` when they pass, otherwise
 * the refusal to send. Never throws; an unreadable request is refused.
 */
export function checkStartHeaders(
  raw: RawRequestLike | undefined,
): DashboardResponse | undefined {
  try {
    if (raw === undefined) return forbidden("The request could not be read.");
    const names = rawHeaderNames(raw);

    const site = headerText(raw, "sec-fetch-site");
    if (
      headerCount(raw, names, "sec-fetch-site") !== 1 ||
      site?.trim().toLowerCase() !== "same-origin"
    ) {
      return forbidden(
        "Starting a capture needs a same-origin request from the dashboard page (Sec-Fetch-Site: same-origin).",
      );
    }

    const host =
      headerText(raw, "host") ?? headerText(raw, ":authority") ?? undefined;
    if (
      headerCount(raw, names, "origin") !== 1 ||
      headerCount(raw, names, "host") > 1 ||
      !isOwnOrigin(
        headerText(raw, "origin"),
        host,
        raw.socket?.encrypted === true,
      )
    ) {
      return forbidden(
        "Starting a capture needs an Origin header equal to this server's own origin.",
      );
    }

    const type = headerText(raw, "content-type");
    const media = type?.split(";")[0]?.trim().toLowerCase();
    if (media !== "application/json") {
      return apiError(
        415,
        "unsupported_media_type",
        "Send the request body as application/json.",
      );
    }

    if (raw.headers?.["transfer-encoding"] !== undefined) {
      return apiError(
        411,
        "length_required",
        "Send the request body with a Content-Length, not chunked.",
      );
    }
    const length = headerText(raw, "content-length");
    if (length === undefined) {
      return apiError(
        411,
        "length_required",
        "Send the request body with a Content-Length.",
      );
    }
    if (!/^\d{1,7}$/.test(length.trim())) {
      return apiError(400, "bad_request", "Content-Length is not a number.");
    }
    const bytes = Number(length.trim());
    if (bytes > START_BODY_LIMIT) {
      return apiError(
        413,
        "payload_too_large",
        `The request body is limited to ${START_BODY_LIMIT} bytes.`,
      );
    }
    if (bytes === 0) {
      return apiError(
        400,
        "bad_request",
        'Send a JSON object, such as {"durationSeconds":30}.',
      );
    }
    return undefined;
  } catch {
    return forbidden("The request could not be read.");
  }
}

/** The stream parts of a raw `IncomingMessage` read here. */
interface BodyStream {
  readonly readableEnded?: boolean;
  readonly destroyed?: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(
    event: string,
    listener: (...args: unknown[]) => void,
  ): unknown;
}

function isBodyStream(value: unknown): value is BodyStream {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as BodyStream).on === "function" &&
    typeof (value as BodyStream).removeListener === "function"
  );
}

export type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly response: DashboardResponse };

const BAD_JSON: BodyResult = Object.freeze({
  ok: false,
  response: apiError(400, "bad_request", "The request body is not JSON."),
});
const TOO_LARGE: BodyResult = Object.freeze({
  ok: false,
  response: apiError(
    413,
    "payload_too_large",
    `The request body is limited to ${START_BODY_LIMIT} bytes.`,
  ),
});
const UNREADABLE: BodyResult = Object.freeze({
  ok: false,
  response: apiError(400, "bad_request", "The request body could not be read."),
});

function parseText(text: string | Buffer): BodyResult {
  const length =
    typeof text === "string" ? Buffer.byteLength(text) : text.length;
  if (length > START_BODY_LIMIT) return TOO_LARGE;
  try {
    return { ok: true, value: JSON.parse(text.toString()) };
  } catch {
    return BAD_JSON;
  }
}

/**
 * The body of a start request whose headers passed `checkStartHeaders` (so `Content-Length` is
 * at most `START_BODY_LIMIT`). Host body parsers usually ran before the handler (Nest registers
 * one on every adapter by default, and Fastify always parses): then their result on `request.body`
 * is used, re-parsed when it is still text. Otherwise the raw stream is read here, up to
 * `START_BODY_LIMIT` bytes and `timeoutMs`. Never rejects.
 */
export function readStartBody(
  request: unknown,
  raw: unknown,
  timeoutMs: number = BODY_READ_TIMEOUT_MS,
): Promise<BodyResult> {
  try {
    const parsed =
      request !== null && typeof request === "object"
        ? (request as { body?: unknown }).body
        : undefined;
    if (parsed !== undefined) {
      if (typeof parsed === "string" || Buffer.isBuffer(parsed)) {
        return Promise.resolve(parseText(parsed));
      }
      return Promise.resolve({ ok: true, value: parsed });
    }
    if (!isBodyStream(raw) || raw.readableEnded === true || raw.destroyed) {
      // Consumed by a layer that left nothing on `request.body`.
      return Promise.resolve(UNREADABLE);
    }
    return readStream(raw, timeoutMs);
  } catch {
    return Promise.resolve(UNREADABLE);
  }
}

function readStream(
  stream: BodyStream,
  timeoutMs: number,
): Promise<BodyResult> {
  return new Promise<BodyResult>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      try {
        if (timer !== undefined) clearTimeout(timer);
        stream.removeListener("data", onData);
        stream.removeListener("end", onEnd);
        stream.removeListener("error", onError);
        stream.removeListener("aborted", onError);
      } catch {
        // Nothing to undo.
      }
      resolve(result);
    };
    const onData = (chunk: unknown): void => {
      try {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk));
        size += buffer.length;
        if (size > START_BODY_LIMIT) {
          finish(TOO_LARGE);
          return;
        }
        chunks.push(buffer);
      } catch {
        finish(UNREADABLE);
      }
    };
    const onEnd = (): void => {
      try {
        finish(parseText(Buffer.concat(chunks)));
      } catch {
        finish(UNREADABLE);
      }
    };
    const onError = (): void => finish(UNREADABLE);
    try {
      timer = setTimeout(() => finish(UNREADABLE), timeoutMs);
      timer.unref?.();
      stream.on("data", onData);
      stream.on("end", onEnd);
      stream.on("error", onError);
      stream.on("aborted", onError);
    } catch {
      finish(UNREADABLE);
    }
  });
}

/** Step 5: the body's fields. Never throws. */
export function parseStartBody(
  value: unknown,
):
  | { readonly ok: true; readonly durationSeconds: number }
  | { readonly ok: false; readonly message: string } {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {
        ok: false,
        message: 'Send a JSON object, such as {"durationSeconds":30}.',
      };
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(profileStartSpec, key)) {
        return {
          ok: false,
          message: `Unknown field ${JSON.stringify(key.slice(0, 64))}.`,
        };
      }
    }
    const spec = profileStartSpec.durationSeconds;
    const given = (value as { durationSeconds?: unknown }).durationSeconds;
    if (given === undefined) return { ok: true, durationSeconds: spec.default };
    if (
      typeof given !== "number" ||
      !Number.isInteger(given) ||
      given < spec.min ||
      given > spec.max
    ) {
      return {
        ok: false,
        message: `durationSeconds must be a whole number from ${spec.min} to ${spec.max}.`,
      };
    }
    return { ok: true, durationSeconds: given };
  } catch {
    return { ok: false, message: "The request body could not be read." };
  }
}

function json(status: number, body: unknown): DashboardResponse {
  return { status, contentType: JSON_TYPE, body: JSON.stringify(body) };
}

/** Starts a capture and answers `202`, `409` or `503`. Never throws. */
export function startCapture(
  profiler: Profiler,
  owner: object,
  durationSeconds: number,
): DashboardResponse {
  const result = profiler.start(durationSeconds * 1000, owner);
  if (result.outcome === "started") return json(202, result.running);
  if (result.outcome === "busy") {
    const body: ProfileConflictError = {
      error: {
        code: "conflict",
        message:
          "A CPU capture is already running in this process; wait for it to end.",
      },
      running: result.running,
    };
    return json(409, body);
  }
  return apiError(
    503,
    "unavailable",
    `The CPU capture could not start: ${result.message}`,
  );
}

const NO_PARAMS: Readonly<Record<string, never>> = {};

/** `GET api/v1/profiles`. */
export function listProfiles(
  target: unknown,
  profiler: Profiler,
): DashboardResponse {
  const parsed = parseQuery(target, NO_PARAMS);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  return json(200, profiler.list());
}

/**
 * The `<id>` segment of `.../profiles/<id>` (`download` false) or `.../profiles/<id>/download`,
 * read from the raw target, so routing parameters of the three adapters do not matter. Matches
 * `profileIdSpec`, or `undefined`.
 */
export function profileIdOf(
  target: unknown,
  download: boolean,
): string | undefined {
  if (typeof target !== "string") return undefined;
  const path = target.split(/[?#]/, 1)[0] ?? "";
  const segments = path.split("/");
  if (download && segments.at(-1)?.toLowerCase() !== "download")
    return undefined;
  const id = segments.at(download ? -2 : -1);
  if (id === undefined || id.length > profileIdSpec.id.maxLength)
    return undefined;
  return ID_PATTERN.test(id) ? id : undefined;
}

const NOT_FOUND = (): DashboardResponse =>
  apiError(404, "not_found", "No such profile; only the last three are kept.");

/** `GET api/v1/profiles/<id>`. */
export function profileDetail(
  target: unknown,
  profiler: Profiler,
): DashboardResponse {
  const parsed = parseQuery(target, NO_PARAMS);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const id = profileIdOf(target, false);
  const detail = id === undefined ? undefined : profiler.get(id);
  return detail === undefined ? NOT_FOUND() : json(200, detail);
}

/** `nestrix-2026-11-11T09-30-00Z-<id>.cpuprofile`: safe in any file system and header. */
export function downloadName(startedAtUnixMs: number, id: string): string {
  let stamp = "profile";
  try {
    stamp = new Date(startedAtUnixMs)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z")
      .replace(/:/g, "-");
  } catch {
    // Keep the plain name.
  }
  return `nestrix-${stamp}-${id}.cpuprofile`;
}

/** `GET api/v1/profiles/<id>/download`: the `.cpuprofile` as an attachment. */
export function profileDownload(
  target: unknown,
  profiler: Profiler,
): DashboardResponse {
  const parsed = parseQuery(target, NO_PARAMS);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  const id = profileIdOf(target, true);
  const file = id === undefined ? undefined : profiler.download(id);
  if (id === undefined || file === undefined) return NOT_FOUND();
  return {
    status: 200,
    contentType: JSON_TYPE,
    body: file.json,
    headers: {
      "content-disposition": `attachment; filename="${downloadName(file.startedAtUnixMs, id)}"`,
    },
  };
}
