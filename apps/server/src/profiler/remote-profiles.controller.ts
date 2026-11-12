/**
 * Remote CPU profiling, dashboard side (docs/backlog/phase-10.md P10-02, D-76), under `/api/v1`:
 *
 * - `GET instances[?service=]`, `GET remote-profiles[?service=&instanceId=]`,
 *   `GET remote-profiles/<id>`, `GET remote-profiles/<id>/download`: any reader (a session, or an
 *   API token: these paths are in `TOKEN_READ_ROUTE` and the global guard admits a token to this
 *   controller for `GET`/`HEAD` only).
 * - `POST remote-profiles`: the admin session only (D-74 keeps API tokens read-only). Three layers
 *   refuse a token: the middleware (a token passes only on `GET`/`HEAD`), the global guard (same),
 *   and `SessionQueryGuard` on the route. Then the embedded `POST profiles` rules (architecture
 *   §4.7), in order: exactly one `Sec-Fetch-Site: same-origin` (403); exactly one `Origin`, equal
 *   to this server's own origin as the single `Host` names it (403); `Content-Type:
 *   application/json` (415); no `Transfer-Encoding` and a `Content-Length` of 1 to 1,024 (411,
 *   413, 400); no query parameters (400); a JSON object with only `service`, `instanceId` and
 *   `durationSeconds` (400). Then `404` for an unknown or stale instance, `409` while a capture is
 *   pending or running for it, `429` with `Retry-After` within 10 s of its previous capture.
 *
 * Every answer is `no-store`, `nosniff`, never CORS; failures are `ApiError`s.
 */
import type { IncomingMessage } from "node:http";
import {
  applyDecorators,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type {
  ApiError,
  ApiErrorCode,
  InstanceListResponse,
  ParamSpec,
  ProfileCooldownError,
  RemoteProfileConflictError,
  RemoteProfileDetail,
  RemoteProfileListResponse,
  RemoteProfileSummary,
} from "@nestrix-js/protocol";
import { originMatchesHost } from "../auth/http.js";
import { ReadQueryGuard, SessionQueryGuard } from "../auth/query-guard.js";
import {
  QUERY_HEADERS,
  QueryExceptionFilter,
} from "../query/exception.filter.js";
import { parseQuery, type Values } from "../query/params.js";
import { parseStart } from "./parse.js";
import { RemoteProfileStore } from "./store.js";

/** Largest accepted start body, bytes (as the embedded `POST profiles`). */
export const START_BODY_LIMIT = 1024;
const CAPTURE_ID = /^[0-9a-f]{16}$/;

const instancesSpec: Readonly<Record<string, ParamSpec>> = {
  service: { kind: "string", maxLength: 256 },
};
const listSpec: Readonly<Record<string, ParamSpec>> = {
  service: { kind: "string", maxLength: 256 },
  instanceId: { kind: "string", maxLength: 256 },
};
const NO_PARAMS: Readonly<Record<string, ParamSpec>> = {};

const Headers = () =>
  applyDecorators(
    ...Object.entries(QUERY_HEADERS).map(([name, value]) =>
      Header(name, value),
    ),
  );

interface RequestLike extends IncomingMessage {
  originalUrl?: string;
}

interface ResponseLike {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

function apiError(status: number, code: ApiErrorCode, message: string): never {
  const body: ApiError = { error: { code, message } };
  throw new HttpException(body, status);
}

function parse(
  req: RequestLike,
  spec: Readonly<Record<string, ParamSpec>>,
): Values {
  const parsed = parseQuery(req.originalUrl ?? req.url, spec);
  if (!parsed.ok) apiError(400, "bad_request", parsed.message);
  return parsed.values;
}

function optional(value: string | number | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** How many times `name` is on the wire (Node keeps one value of some headers). */
function headerCount(req: IncomingMessage, name: string): number {
  let count = 0;
  const raw = req.rawHeaders;
  if (!Array.isArray(raw)) return 0;
  for (let i = 0; i < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() === name) count++;
  }
  return count;
}

/**
 * The header rules of a start, in order (see the module comment). Throws the refusal; never
 * lets an unreadable request through.
 */
export function checkStartHeaders(req: IncomingMessage): void {
  let refusal:
    | { status: number; code: ApiErrorCode; message: string }
    | undefined;
  try {
    const site = req.headers["sec-fetch-site"];
    const origin = req.headers.origin;
    const media = (req.headers["content-type"] ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const length = req.headers["content-length"];
    if (
      headerCount(req, "sec-fetch-site") !== 1 ||
      typeof site !== "string" ||
      site.trim().toLowerCase() !== "same-origin"
    ) {
      refusal = {
        status: 403,
        code: "forbidden",
        message:
          "Starting a capture needs a same-origin request from the dashboard page (Sec-Fetch-Site: same-origin).",
      };
    } else if (
      headerCount(req, "origin") !== 1 ||
      typeof origin !== "string" ||
      origin === "null" ||
      !originMatchesHost(req)
    ) {
      refusal = {
        status: 403,
        code: "forbidden",
        message:
          "Starting a capture needs an Origin header equal to this server's own origin.",
      };
    } else if (media !== "application/json") {
      refusal = {
        status: 415,
        code: "unsupported_media_type",
        message: "Send the request body as application/json.",
      };
    } else if (req.headers["transfer-encoding"] !== undefined) {
      refusal = {
        status: 411,
        code: "length_required",
        message: "Send the request body with a Content-Length, not chunked.",
      };
    } else if (typeof length !== "string") {
      refusal = {
        status: 411,
        code: "length_required",
        message: "Send the request body with a Content-Length.",
      };
    } else if (!/^\d{1,7}$/.test(length.trim())) {
      refusal = {
        status: 400,
        code: "bad_request",
        message: "Content-Length is not a number.",
      };
    } else if (Number(length.trim()) > START_BODY_LIMIT) {
      refusal = {
        status: 413,
        code: "payload_too_large",
        message: `The request body is limited to ${START_BODY_LIMIT} bytes.`,
      };
    } else if (Number(length.trim()) === 0) {
      refusal = {
        status: 400,
        code: "bad_request",
        message: "Send a JSON object with service and instanceId.",
      };
    }
  } catch {
    refusal = {
      status: 403,
      code: "forbidden",
      message: "The request could not be read.",
    };
  }
  if (refusal !== undefined)
    apiError(refusal.status, refusal.code, refusal.message);
}

/** `nestrix-<service-safe>-2026-11-11T09-30-00Z-<id>.cpuprofile`: safe in any file system and header. */
export function downloadName(
  service: string,
  startedAtUnixMs: number,
  id: string,
): string {
  let stamp = "profile";
  try {
    stamp = new Date(startedAtUnixMs)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z")
      .replace(/:/g, "-");
  } catch {
    // Keep the plain name.
  }
  const safe = service.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return `nestrix-${safe}-${stamp}-${id}.cpuprofile`;
}

@Controller("api/v1")
@UseGuards(ReadQueryGuard)
@UseFilters(QueryExceptionFilter)
export class RemoteProfilesController {
  constructor(private readonly store: RemoteProfileStore) {}

  @Get("instances")
  @Headers()
  async instances(@Req() req: RequestLike): Promise<InstanceListResponse> {
    const v = parse(req, instancesSpec);
    return { instances: await this.store.instances(optional(v.service)) };
  }

  @Post("remote-profiles")
  @UseGuards(SessionQueryGuard)
  @HttpCode(202)
  @Headers()
  async start(
    @Req() req: RequestLike,
    @Res({ passthrough: true }) res: ResponseLike,
    @Body() body: unknown,
  ): Promise<
    RemoteProfileSummary | RemoteProfileConflictError | ProfileCooldownError
  > {
    checkStartHeaders(req);
    parse(req, NO_PARAMS);
    const v = parseStart(body);
    if (!v.ok) apiError(400, "bad_request", v.message);
    const result = await this.store.start(
      v.service,
      v.instanceId,
      v.durationSeconds * 1000,
      "admin",
    );
    if (result.kind === "started") return result.capture;
    if (result.kind === "not_found") {
      apiError(
        404,
        "not_found",
        "No such instance has checked in during the last 2 minutes.",
      );
    }
    if (result.kind === "conflict") {
      res.status(409);
      return {
        error: {
          code: "conflict",
          message:
            "A capture is already pending or running for this instance; wait for it to end.",
        },
        capture: result.capture,
      };
    }
    res.status(429);
    res.setHeader("Retry-After", String(result.retryAfterSeconds));
    return {
      error: {
        code: "too_many_requests",
        message: `A new capture for this instance can start 10 s after the previous one finished; try again in ${result.retryAfterSeconds} s.`,
      },
      retryAfterSeconds: result.retryAfterSeconds,
    };
  }

  @Get("remote-profiles")
  @Headers()
  async list(@Req() req: RequestLike): Promise<RemoteProfileListResponse> {
    const v = parse(req, listSpec);
    return {
      profiles: await this.store.list(
        optional(v.service),
        optional(v.instanceId),
      ),
    };
  }

  @Get("remote-profiles/:id")
  @Headers()
  async detail(
    @Req() req: RequestLike,
    @Param("id") id: string,
  ): Promise<RemoteProfileDetail> {
    parse(req, NO_PARAMS);
    const summary = CAPTURE_ID.test(id) ? await this.store.get(id) : undefined;
    if (summary === undefined) apiError(404, "not_found", "No such capture.");
    if (summary.state !== "done") return summary;
    const computed = await this.store.summaryOf(id);
    // Removed by retention between the two reads: answer what the first read saw.
    return computed === undefined ? summary : { ...summary, ...computed };
  }

  @Get("remote-profiles/:id/download")
  @Headers()
  async download(
    @Req() req: RequestLike,
    @Param("id") id: string,
  ): Promise<StreamableFile> {
    parse(req, NO_PARAMS);
    const stored = CAPTURE_ID.test(id)
      ? await this.store.profileJson(id)
      : undefined;
    if (stored === undefined) {
      apiError(404, "not_found", "No profile is stored for this capture.");
    }
    const name = downloadName(
      stored.summary.service,
      stored.summary.startedAtUnixMs ?? stored.summary.requestedAtUnixMs,
      id,
    );
    return new StreamableFile(stored.json, {
      type: "application/json",
      disposition: `attachment; filename="${name}"`,
      length: stored.json.length,
    });
  }
}
