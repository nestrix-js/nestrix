/**
 * Issue #39 (D-82): an OTLP path this server does not ingest (`/v1/metrics`, or any other `/v1/…`
 * path that is not an ingest route) answers `404` with an OTLP-shaped body, `google.rpc.Status` in
 * the request's encoding (protobuf for `application/x-protobuf`, JSON otherwise), as the receiver
 * answers its own errors. Mounted by `configureApp` before the admin login's middleware, so an
 * exporter sees "not found" (which the OTLP exporters do not retry, and which a Nestrix app takes as
 * "metrics not accepted here") instead of the admin layer's 403 or 503, and no key is needed to learn
 * it. Nothing is read from the body: it is discarded, bounded, so the client sees the answer.
 *
 * Paths with a dot segment or a percent-escape are left to the admin layer (default deny), so this
 * never decides for a path Express might route elsewhere. Never throws.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { create, toBinary, toJsonString } from "@bufbuild/protobuf";
import { pathnameOf } from "../auth/http.js";
import { StatusSchema } from "../proto/gen/google/rpc/status_pb.js";
import { discardRest } from "./body.js";
import { DISCARD_BUDGET_BYTES, parseContentType } from "./receiver.js";
import { INGEST_PATH_PATTERN } from "./tokens.js";

/** `/v1/` and plain segments only: no `.`/`..` segment, no percent-escape. */
const OTLP_NAMESPACE = /^\/v1\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*\/?)*$/i;
const DOT_SEGMENT = /\/\.{1,2}(?:\/|$)/;

export const UNKNOWN_OTLP_PATH_MESSAGE =
  "not found: this server ingests OTLP traces (POST /v1/traces) and logs (POST /v1/logs) only; send metrics to an OpenTelemetry Collector";

/** Whether `req` is for a `/v1/…` path this server does not ingest. */
export function isUnknownOtlpPath(req: IncomingMessage): boolean {
  const path = pathnameOf(req);
  return (
    OTLP_NAMESPACE.test(path) &&
    !DOT_SEGMENT.test(path) &&
    !INGEST_PATH_PATTERN.test(path)
  );
}

type Next = (error?: unknown) => void;

/** The `app.use()` middleware. */
export function unknownOtlpPathMiddleware(
  discardTimeoutMs: number,
): (req: IncomingMessage, res: ServerResponse, next: Next) => void {
  return (req, res, next) => {
    let unknown = false;
    try {
      unknown = isUnknownOtlpPath(req);
    } catch {
      unknown = false;
    }
    if (!unknown) {
      next();
      return;
    }
    try {
      discardRest(req, DISCARD_BUDGET_BYTES, discardTimeoutMs);
      const protobuf =
        parseContentType(req.headers["content-type"]) === "protobuf";
      const status = create(StatusSchema, {
        code: 5, // google.rpc.Code.NOT_FOUND
        message: UNKNOWN_OTLP_PATH_MESSAGE,
      });
      const body = protobuf
        ? toBinary(StatusSchema, status)
        : toJsonString(StatusSchema, status);
      res.statusCode = 404;
      res.setHeader(
        "Content-Type",
        protobuf ? "application/x-protobuf" : "application/json",
      );
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(body);
    } catch {
      try {
        if (!res.headersSent) res.statusCode = 404;
        res.end();
      } catch {
        // The client is gone.
      }
    }
  };
}
