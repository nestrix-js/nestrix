/**
 * OTLP/HTTP receiver: traces (`POST /v1/traces`) and, with the same checks, logs
 * (`POST /v1/logs`, P9-07: records with a trace id are kept next to their trace). Works on the raw
 * Node request and response so that it alone reads the body. Both paths share the auth, the rate
 * limiter (per API key, across both paths), the in-flight memory budget and every limit; a log
 * export's item limit (`maxSpans`) counts log records. Order of checks: content type (to pick the response encoding),
 * auth (401), rate limit (429), media type and content encoding (415), declared length (413),
 * body (413, 400), decoding (400), the sink (503). Every response body is the OTLP message in
 * the request's encoding: `ExportTraceServiceResponse` (`ExportLogsServiceResponse` for logs) on 200,
 * `google.rpc.Status` otherwise.
 *
 * `handle` never rejects: whatever fails is answered (500 if nothing more specific applies) or,
 * when the client is gone, dropped.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { create, toBinary, toJsonString } from "@bufbuild/protobuf";
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import type { ServerConfig } from "../config.js";
import { SERVER_CONFIG } from "../config.module.js";
import { StatusSchema } from "../proto/gen/google/rpc/status_pb.js";
import { ExportLogsServiceResponseSchema } from "../proto/gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js";
import { ExportTraceServiceResponseSchema } from "../proto/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";
import { IngestAuth } from "./auth.js";
import {
  BodyError,
  ClientGoneError,
  discardRest,
  parseContentEncoding,
  readBody,
} from "./body.js";
import {
  type BodyFormat,
  checkBody,
  DecodeError,
  decodeLogsRequest,
  decodeRequest,
} from "./decode.js";
import {
  ByteBudget,
  type DecodeLimits,
  decodeCharge,
  LimitError,
  LOG_SHAPE,
  TRACE_SHAPE,
  type WireShape,
} from "./limits.js";
import { toIngestBatch } from "./map.js";
import { toIngestLogBatch } from "./map-logs.js";
import {
  type IngestBatch,
  IngestBusyError,
  type IngestLogBatch,
  type IngestSink,
} from "./model.js";
import { RateLimiter } from "./rate-limit.js";
import { INGEST_SINK } from "./tokens.js";

/** Retry-After for a sink failure that is not `IngestBusyError` (e.g. the database is down). */
const SINK_FAILURE_RETRY_SECONDS = 5;
const MAX_RETRY_AFTER_SECONDS = 3600;
const LOG_INTERVAL_MS = 60_000;
/**
 * After an early answer, up to this much of the unread body is read and discarded so the client
 * sees the response; beyond it the connection is destroyed.
 */
export const DISCARD_BUDGET_BYTES = 4 * 1024 * 1024;
/** Message nesting accepted in a request (deeper is 400). */
const MAX_DEPTH = 64;
/** Retry-After when the in-flight memory budget is full. */
const BUSY_RETRY_SECONDS = 1;

function busy(): Reply {
  return {
    status: 503,
    message: "the server is busy with other requests, retry later",
    headers: { "Retry-After": String(BUSY_RETRY_SECONDS) },
  };
}

/** `application/x-protobuf` or `application/json` (parameters ignored); anything else is `undefined`. */
export function parseContentType(
  header: string | undefined,
): BodyFormat | undefined {
  if (header === undefined) return undefined;
  const media = header.split(";", 1)[0].trim().toLowerCase();
  if (media === "application/x-protobuf") return "protobuf";
  if (media === "application/json") return "json";
  return undefined;
}

type Outcome = { body: Uint8Array | string } | Reply;

/** What differs between `/v1/traces` and `/v1/logs`: the message walked and decoded, and the sink call. */
interface Signal<B> {
  shape: WireShape;
  decode(body: Buffer, format: BodyFormat, limits: DecodeLimits): B;
  store(batch: B, format: BodyFormat): Promise<Outcome>;
}

interface Reply {
  status: number;
  message: string;
  headers?: Record<string, string>;
  /** Close the connection instead of discarding the unread body (it is known to be too large). */
  close?: boolean;
}

@Injectable()
export class IngestReceiver implements OnApplicationBootstrap {
  private readonly logger = new Logger("Ingest");
  private readonly auth: IngestAuth;
  private readonly limiter: RateLimiter;
  /** Shared by every request this server handles (one server per process). */
  readonly budget: ByteBudget;
  private readonly limits: DecodeLimits;
  private lastSinkLogMs = Number.NEGATIVE_INFINITY;
  private suppressedSinkLogs = 0;
  private readonly traces: Signal<IngestBatch> = {
    shape: TRACE_SHAPE,
    decode: (body, format, limits) =>
      toIngestBatch(decodeRequest(body, format, limits)),
    store: (batch, format) => this.store(batch, format),
  };
  private readonly logs: Signal<IngestLogBatch> = {
    shape: LOG_SHAPE,
    decode: (body, format, limits) =>
      toIngestLogBatch(decodeLogsRequest(body, format, limits)),
    store: (batch, format) => this.storeLogs(batch, format),
  };

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @Inject(INGEST_SINK) private readonly sink: IngestSink,
  ) {
    this.auth = new IngestAuth(config.ingest);
    this.limiter = new RateLimiter(config.ingest.rateLimit);
    this.budget = new ByteBudget(config.ingest.inflightBudgetBytes);
    this.limits = {
      maxSpans: config.ingest.maxSpans,
      maxMessages: config.ingest.maxMessages,
      maxJsonTokens: config.ingest.maxJsonTokens,
      maxDepth: MAX_DEPTH,
    };
  }

  onApplicationBootstrap(): void {
    const { auth, keys } = this.config.ingest;
    if (auth === "none") {
      this.logger.warn(
        "NESTRIX_INGEST_AUTH=none: POST /v1/traces and /v1/logs accept data from anyone who can reach this port. Use it for local demos only.",
      );
    } else if (auth === "unconfigured") {
      this.logger.warn(
        "Ingest is not configured, so POST /v1/traces and /v1/logs answer 401. Set NESTRIX_INGEST_KEYS (comma-separated keys of at least 32 characters) or, for a local demo, NESTRIX_INGEST_AUTH=none.",
      );
    } else {
      this.logger.log(
        `POST /v1/traces and /v1/logs require an API key (${keys.length} configured).`,
      );
    }
  }

  /** `POST /v1/traces`. Never rejects. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.handleSignal(req, res, this.traces);
  }

  /** `POST /v1/logs` (P9-07): every check of `handle`, then the log mapper and `writeLogs`. Never rejects. */
  handleLogs(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.handleSignal(req, res, this.logs);
  }

  private async handleSignal<B>(
    req: IncomingMessage,
    res: ServerResponse,
    signal: Signal<B>,
  ): Promise<void> {
    let format: BodyFormat = "json";
    try {
      format = parseContentType(req.headers["content-type"]) ?? "json";
      const outcome = await this.process(req, format, signal);
      if (outcome === undefined) return; // Client gone.
      if ("body" in outcome) {
        this.send(res, 200, format, outcome.body, {}, false);
      } else {
        this.reply(req, res, format, outcome);
      }
    } catch (error) {
      this.logThrottled("Ingest request failed unexpectedly", error);
      this.reply(req, res, format, { status: 500, message: "internal error" });
    }
  }

  /**
   * The ingest key (401) and the rate limit (429) of every ingest-key route: `/v1/traces`,
   * `/v1/logs` and the instance side of remote profiling (P10-02), which share one bucket per
   * key. `principal` is `key:<n>`, or `ip:<address>` with auth off. Never throws.
   */
  admit(req: IncomingMessage):
    | { ok: true; principal: string }
    | {
        ok: false;
        status: number;
        message: string;
        headers: Record<string, string>;
      } {
    try {
      const auth = this.auth.check(
        req.headers,
        req.socket?.remoteAddress ?? "unknown",
      );
      if (!auth.ok) {
        return {
          ok: false,
          status: 401,
          message: auth.message,
          headers: { "WWW-Authenticate": 'Bearer realm="nestrix-ingest"' },
        };
      }
      const rate = this.limiter.take(auth.principal);
      if (!rate.ok) {
        return {
          ok: false,
          status: 429,
          message: "too many export requests for this API key",
          headers: { "Retry-After": String(rate.retryAfterSeconds) },
        };
      }
      return { ok: true, principal: auth.principal };
    } catch {
      return {
        ok: false,
        status: 500,
        message: "internal error",
        headers: {},
      };
    }
  }

  private async process<B>(
    req: IncomingMessage,
    format: BodyFormat,
    signal: Signal<B>,
  ): Promise<Outcome | undefined> {
    const admitted = this.admit(req);
    if (!admitted.ok) {
      return {
        status: admitted.status,
        message: admitted.message,
        headers: admitted.headers,
      };
    }

    if (parseContentType(req.headers["content-type"]) === undefined) {
      return {
        status: 415,
        message:
          "unsupported Content-Type: send application/x-protobuf or application/json",
      };
    }
    const encoding = parseContentEncoding(req.headers["content-encoding"]);
    if (encoding === undefined) {
      return {
        status: 415,
        message: "unsupported Content-Encoding: send gzip or identity",
      };
    }

    const limit = this.config.ingest.maxBodyBytes;
    const declared = req.headers["content-length"];
    if (declared !== undefined && Number(declared) > limit) {
      return {
        status: 413,
        message: `request body exceeds the limit of ${limit} bytes`,
        close: true,
      };
    }

    // Everything this request holds in memory is charged to the shared budget and released
    // when it is done, whatever the outcome.
    let charged = 0;
    const reserve = (bytes: number): boolean => {
      if (!this.budget.tryTake(bytes)) return false;
      charged += bytes;
      return true;
    };
    try {
      if (this.budget.inUse >= this.budget.capacity) return busy();

      let body: Buffer;
      try {
        body = await readBody(req, encoding, limit, reserve);
      } catch (error) {
        if (error instanceof ClientGoneError) return undefined;
        if (error instanceof BodyError) {
          return error.status === 503
            ? busy()
            : { status: error.status, message: error.message };
        }
        throw error;
      }

      let batch: B;
      try {
        const cost = checkBody(body, format, this.limits, signal.shape);
        const charge = decodeCharge(cost);
        if (charged + charge > this.budget.capacity) {
          return {
            status: 413,
            message: "request would decode into more than the server accepts",
          };
        }
        if (!reserve(charge)) return busy();
        batch = signal.decode(body, format, this.limits);
      } catch (error) {
        if (error instanceof DecodeError) {
          return { status: 400, message: error.message };
        }
        if (error instanceof LimitError) {
          return { status: 413, message: error.message };
        }
        throw error;
      }

      return await signal.store(batch, format);
    } finally {
      this.budget.release(charged);
    }
  }

  private async store(
    batch: IngestBatch,
    format: BodyFormat,
  ): Promise<Outcome> {
    if (batch.resourceSpans.length > 0) {
      try {
        await this.sink.write(batch);
      } catch (error) {
        if (error instanceof IngestBusyError) {
          return {
            status: 503,
            message: "ingest is over capacity, retry later",
            headers: { "Retry-After": String(retryAfter(error)) },
          };
        }
        this.logThrottled("Storing spans failed", error);
        return {
          status: 503,
          message: "spans could not be stored, retry later",
          headers: { "Retry-After": String(SINK_FAILURE_RETRY_SECONDS) },
        };
      }
    }

    const response = create(
      ExportTraceServiceResponseSchema,
      batch.rejectedSpans > 0
        ? {
            partialSuccess: {
              rejectedSpans: BigInt(batch.rejectedSpans),
              errorMessage: batch.errorMessage ?? "",
            },
          }
        : {},
    );
    return {
      body:
        format === "protobuf"
          ? toBinary(ExportTraceServiceResponseSchema, response)
          : toJsonString(ExportTraceServiceResponseSchema, response),
    };
  }

  /** Log records: as `store`, with `writeLogs` (a sink without it keeps nothing). */
  private async storeLogs(
    batch: IngestLogBatch,
    format: BodyFormat,
  ): Promise<Outcome> {
    const writeLogs = this.sink.writeLogs?.bind(this.sink);
    if (batch.resourceLogs.length > 0 && writeLogs !== undefined) {
      try {
        await writeLogs(batch);
      } catch (error) {
        if (error instanceof IngestBusyError) {
          return {
            status: 503,
            message: "ingest is over capacity, retry later",
            headers: { "Retry-After": String(retryAfter(error)) },
          };
        }
        this.logThrottled("Storing log records failed", error);
        return {
          status: 503,
          message: "log records could not be stored, retry later",
          headers: { "Retry-After": String(SINK_FAILURE_RETRY_SECONDS) },
        };
      }
    }

    const response = create(
      ExportLogsServiceResponseSchema,
      batch.rejectedLogRecords > 0
        ? {
            partialSuccess: {
              rejectedLogRecords: BigInt(batch.rejectedLogRecords),
              errorMessage: batch.errorMessage ?? "",
            },
          }
        : {},
    );
    return {
      body:
        format === "protobuf"
          ? toBinary(ExportLogsServiceResponseSchema, response)
          : toJsonString(ExportLogsServiceResponseSchema, response),
    };
  }

  private reply(
    req: IncomingMessage,
    res: ServerResponse,
    format: BodyFormat,
    reply: Reply,
  ): void {
    const unread = !req.complete;
    const close = unread && reply.close === true;
    // The client is usually still sending: keep reading (and discarding) so it gets this answer
    // instead of stalling on a paused socket or a reset.
    if (unread && !close) {
      discardRest(
        req,
        DISCARD_BUDGET_BYTES,
        this.config.ingest.discardTimeoutMs,
      );
    }
    try {
      const status = create(StatusSchema, { message: reply.message });
      const body =
        format === "protobuf"
          ? toBinary(StatusSchema, status)
          : toJsonString(StatusSchema, status);
      this.send(res, reply.status, format, body, reply.headers ?? {}, close);
    } catch (error) {
      this.logThrottled("Writing an ingest error response failed", error);
    }
  }

  private send(
    res: ServerResponse,
    status: number,
    format: BodyFormat,
    body: Uint8Array | string,
    headers: Record<string, string>,
    closeConnection: boolean,
  ): void {
    try {
      if (res.headersSent || res.writableEnded || res.destroyed) return;
      res.statusCode = status;
      res.setHeader(
        "Content-Type",
        format === "protobuf" ? "application/x-protobuf" : "application/json",
      );
      for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
      }
      // The rest of the body will not be read: close the connection after answering.
      if (closeConnection) res.setHeader("Connection", "close");
      res.end(body);
    } catch (error) {
      this.logThrottled("Writing an ingest response failed", error);
    }
  }

  private logThrottled(message: string, error: unknown): void {
    try {
      const now = performance.now();
      if (now - this.lastSinkLogMs < LOG_INTERVAL_MS) {
        this.suppressedSinkLogs++;
        return;
      }
      const suppressed = this.suppressedSinkLogs;
      this.lastSinkLogMs = now;
      this.suppressedSinkLogs = 0;
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        suppressed > 0
          ? `${message}: ${detail} (${suppressed} similar messages suppressed)`
          : `${message}: ${detail}`,
      );
    } catch {
      // Logging must not fail a request.
    }
  }
}

function retryAfter(error: IngestBusyError): number {
  const seconds = Math.ceil(Number(error.retryAfterSeconds));
  if (!Number.isFinite(seconds) || seconds < 1) return 1;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}
