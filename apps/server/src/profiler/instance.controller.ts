/**
 * Remote CPU profiling, instance side (docs/backlog/phase-10.md P10-02, D-76): the routes an app
 * instance calls on the ingest port with its ingest key, exactly like `/v1/traces`:
 *
 * - `POST /v1/nestrix/check-in` (`CheckInRequest`): `200` with `CheckInResponse`.
 * - `POST /v1/nestrix/profiles/<id>` (the `.cpuprofile`, gzip allowed): `204`.
 * - `POST /v1/nestrix/profiles/<id>/failed` (`CaptureFailedRequest`): `204`.
 *
 * Shared with the receiver (`IngestReceiver`): the key check (401), the per-key rate limit (429,
 * one bucket across traces, logs and these routes), and the in-flight memory budget (503). Order
 * of checks: key and rate limit, the id (404), media type and content encoding (415), declared
 * length (413), for an upload the capture's ownership before the body is read (404 unknown or
 * owned by another key, 409 not running), the body (413, 400), then the transition (404, 409).
 * Answers are JSON (`ApiError` on failure), with `no-store` and `nosniff` and never a CORS
 * header. No handler rejects: whatever fails is answered 500 or, with the client gone, dropped.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import {
  Controller,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { ApiErrorCode, CheckInResponse } from "@nestrix-js/protocol";
import type { ServerConfig } from "../config.js";
import { SERVER_CONFIG } from "../config.module.js";
import {
  BodyError,
  ClientGoneError,
  discardRest,
  parseContentEncoding,
  readBody,
} from "../ingest/body.js";
import { checkJson, decodeCharge, LimitError } from "../ingest/limits.js";
import { DISCARD_BUDGET_BYTES, IngestReceiver } from "../ingest/receiver.js";
import {
  CHECK_IN_PATH,
  PROFILE_FAILED_PATH,
  PROFILE_UPLOAD_PATH,
} from "../ingest/tokens.js";
import { readCpuProfile } from "./cpuprofile.js";
import { normalizeProfile } from "./normalize.js";
import { parseCheckIn, parseFailed } from "./parse.js";
import {
  CHECK_IN_INTERVAL_MS,
  type OwnedResult,
  RemoteProfileStore,
} from "./store.js";

const gzip = promisify(gzipCallback);

/** Largest check-in or failure body accepted (after decompression). */
export const SMALL_BODY_LIMIT = 16 * 1024;
const CAPTURE_ID = /^[0-9a-f]{16}$/;
const LOG_INTERVAL_MS = 60_000;

interface Reply {
  status: number;
  code?: ApiErrorCode;
  message?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Close the connection instead of reading the rest of the body (known to be too large). */
  close?: boolean;
}

function error(
  status: number,
  code: ApiErrorCode,
  message: string,
  headers?: Record<string, string>,
): Reply {
  return headers === undefined
    ? { status, code, message }
    : { status, code, message, headers };
}

const NOT_FOUND = (): Reply =>
  error(404, "not_found", "No capture with this id is waiting for this key.");
const NOT_RUNNING = (): Reply =>
  error(409, "conflict", "The capture is not running (finished or expired).");

function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 401:
      return "unauthorized";
    case 429:
      return "too_many_requests";
    case 400:
      return "bad_request";
    case 413:
      return "payload_too_large";
    case 503:
      return "unavailable";
    default:
      return "internal";
  }
}

function ownedReply(result: OwnedResult): Reply | undefined {
  if (result === "not_found") return NOT_FOUND();
  if (result === "wrong_state") return NOT_RUNNING();
  return undefined;
}

@Controller()
export class InstanceController {
  private readonly logger = new Logger("NestrixRemoteProfiles");
  private lastLogMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly receiver: IngestReceiver,
    private readonly store: RemoteProfileStore,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  @Post(CHECK_IN_PATH)
  checkIn(
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): Promise<void> {
    return this.handle(req, res, async (principal) => {
      const read = await this.readJson(req, SMALL_BODY_LIMIT);
      if ("status" in read) return read;
      const parsed = parseCheckIn(read.value);
      if (!parsed.ok) return error(400, "bad_request", parsed.message);
      const result = await this.store.checkIn(parsed.checkIn, principal);
      if (result.kind === "conflict") {
        return error(
          409,
          "conflict",
          "This instance id checked in with another ingest key.",
        );
      }
      const body: CheckInResponse = { nextCheckInMs: CHECK_IN_INTERVAL_MS };
      if (result.capture !== undefined) body.capture = result.capture;
      return { status: 200, body };
    });
  }

  @Post(PROFILE_UPLOAD_PATH)
  upload(
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
    @Param("id") id: string,
  ): Promise<void> {
    return this.handle(req, res, async (principal) => {
      if (!CAPTURE_ID.test(id)) return NOT_FOUND();
      const limit = this.config.ingest.maxBodyBytes;
      const early = this.checkHeaders(req, limit);
      if (early !== undefined) return early;
      const owned = ownedReply(await this.store.checkOwned(id, principal));
      if (owned !== undefined) return owned;

      let charged = 0;
      const reserve = (bytes: number): boolean => {
        if (!this.receiver.budget.tryTake(bytes)) return false;
        charged += bytes;
        return true;
      };
      try {
        const read = await this.readJson(req, limit, reserve, true);
        if ("status" in read) return read;
        const profile = readCpuProfile(read.value);
        if (!profile.ok) return error(400, "bad_request", profile.message);
        const json = JSON.stringify(profile.profile);
        let summary: ReturnType<typeof normalizeProfile>;
        try {
          // The same code that computes the detail later: a profile it cannot read is refused now.
          summary = normalizeProfile(json);
        } catch {
          return error(400, "bad_request", "not a CPU profile");
        }
        const stored = Buffer.from(summary.json, "utf8");
        const gzipped = await gzip(stored);
        const done = await this.store.complete(id, principal, {
          gzipped,
          bytes: stored.length,
          samples: summary.samples,
          actualDurationMs: summary.actualDurationMs,
        });
        return ownedReply(done) ?? { status: 204 };
      } finally {
        this.receiver.budget.release(charged);
      }
    });
  }

  @Post(PROFILE_FAILED_PATH)
  failed(
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
    @Param("id") id: string,
  ): Promise<void> {
    return this.handle(req, res, async (principal) => {
      if (!CAPTURE_ID.test(id)) return NOT_FOUND();
      const read = await this.readJson(req, SMALL_BODY_LIMIT);
      if ("status" in read) return read;
      const parsed = parseFailed(read.value);
      if (!parsed.ok) return error(400, "bad_request", parsed.message);
      const result = await this.store.fail(id, principal, parsed.message);
      return ownedReply(result) ?? { status: 204 };
    });
  }

  /** Admission, then `work`; answers whatever comes back. Never rejects. */
  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    work: (principal: string) => Promise<Reply | undefined>,
  ): Promise<void> {
    try {
      const admitted = this.receiver.admit(req);
      if (!admitted.ok) {
        this.reply(req, res, {
          status: admitted.status,
          code: codeForStatus(admitted.status),
          message: admitted.message,
          headers: admitted.headers,
        });
        return;
      }
      const reply = await work(admitted.principal);
      if (reply === undefined) return; // The client went away.
      this.reply(req, res, reply);
    } catch (failure) {
      this.logThrottled(failure);
      this.reply(req, res, error(500, "internal", "internal error"));
    }
  }

  /** Media type, content encoding and declared length (415, 413). */
  private checkHeaders(req: IncomingMessage, limit: number): Reply | undefined {
    const media = (req.headers["content-type"] ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (media !== "application/json") {
      return error(
        415,
        "unsupported_media_type",
        "unsupported Content-Type: send application/json",
      );
    }
    if (parseContentEncoding(req.headers["content-encoding"]) === undefined) {
      return error(
        415,
        "unsupported_media_type",
        "unsupported Content-Encoding: send gzip or identity",
      );
    }
    const declared = req.headers["content-length"];
    if (declared !== undefined && Number(declared) > limit) {
      return {
        ...error(
          413,
          "payload_too_large",
          `request body exceeds the limit of ${limit} bytes`,
        ),
        close: true,
      };
    }
    return undefined;
  }

  /**
   * Reads and parses a JSON body. With `checkSize`, the JSON's values are counted on the raw bytes
   * first (the ingest limits) and their estimated decoded size charged to the budget, so a small
   * body cannot parse into a huge object graph. A client that went away yields `{ status: 0 }`,
   * which `reply` does not answer.
   */
  private async readJson(
    req: IncomingMessage,
    limit: number,
    reserve?: (bytes: number) => boolean,
    checkSize = false,
  ): Promise<{ value: unknown } | Reply> {
    const early = this.checkHeaders(req, limit);
    if (early !== undefined) return early;
    const encoding = parseContentEncoding(req.headers["content-encoding"]);
    let charged = 0;
    const take =
      reserve ??
      ((bytes: number): boolean => {
        if (!this.receiver.budget.tryTake(bytes)) return false;
        charged += bytes;
        return true;
      });
    try {
      if (this.receiver.budget.inUse >= this.receiver.budget.capacity) {
        return error(
          503,
          "unavailable",
          "the server is busy with other requests, retry later",
          { "Retry-After": "1" },
        );
      }
      let body: Buffer;
      try {
        body = await readBody(req, encoding ?? "identity", limit, take);
      } catch (failure) {
        if (failure instanceof ClientGoneError) return { status: 0 };
        if (failure instanceof BodyError) {
          return failure.status === 503
            ? error(503, "unavailable", failure.message, { "Retry-After": "1" })
            : error(
                failure.status,
                failure.status === 413 ? "payload_too_large" : "bad_request",
                failure.message,
              );
        }
        throw failure;
      }
      if (checkSize) {
        try {
          const cost = checkJson(body, {
            maxSpans: 0,
            maxMessages: this.config.ingest.maxMessages,
            maxJsonTokens: this.config.ingest.maxJsonTokens,
            maxDepth: 64,
          });
          if (!take(decodeCharge(cost))) {
            return error(
              503,
              "unavailable",
              "the server is busy with other requests, retry later",
              { "Retry-After": "1" },
            );
          }
        } catch (failure) {
          if (failure instanceof LimitError) {
            return error(413, "payload_too_large", failure.message);
          }
          throw failure;
        }
      }
      try {
        return { value: JSON.parse(body.toString("utf8")) };
      } catch {
        return error(400, "bad_request", "request body is not valid JSON");
      }
    } finally {
      if (reserve === undefined) this.receiver.budget.release(charged);
    }
  }

  private reply(req: IncomingMessage, res: ServerResponse, reply: Reply): void {
    try {
      if (reply.status === 0) return; // The client went away; nobody to answer.
      const unread = !req.complete;
      const close = unread && reply.close === true;
      if (unread && !close) {
        discardRest(
          req,
          DISCARD_BUDGET_BYTES,
          this.config.ingest.discardTimeoutMs,
        );
      }
      if (res.headersSent || res.writableEnded || res.destroyed) return;
      res.statusCode = reply.status;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      for (const [name, value] of Object.entries(reply.headers ?? {})) {
        res.setHeader(name, value);
      }
      if (close) res.setHeader("Connection", "close");
      if (reply.status === 204) {
        res.end();
        return;
      }
      const body =
        reply.body ??
        ({
          error: {
            code: reply.code ?? "internal",
            message: reply.message ?? "",
          },
        } as const);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(body));
    } catch (failure) {
      this.logThrottled(failure);
      try {
        res.destroy();
      } catch {
        // Nothing more can be done for this response.
      }
    }
  }

  private logThrottled(failure: unknown): void {
    try {
      const now = performance.now();
      if (now - this.lastLogMs < LOG_INTERVAL_MS) return;
      this.lastLogMs = now;
      this.logger.error(
        `remote profiling request failed: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    } catch {
      // Logging must not fail a request.
    }
  }
}
