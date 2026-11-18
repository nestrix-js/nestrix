import type { IncomingMessage, ServerResponse } from "node:http";
import { Controller, Post, Req, Res } from "@nestjs/common";
import { IngestReceiver } from "./receiver.js";
import {
  INGEST_LOGS_PATH,
  INGEST_METRICS_PATH,
  INGEST_TRACES_PATH,
} from "./tokens.js";

/**
 * `POST /v1/traces`, `POST /v1/logs` and (issue #18) `POST /v1/metrics`. `@Res()` hands the raw response to the receiver, which
 * writes it; the body is read from the raw request, so no body parser may run on these paths (see
 * `configureApp`).
 */
@Controller()
export class IngestController {
  constructor(private readonly receiver: IngestReceiver) {}

  @Post(INGEST_TRACES_PATH)
  receive(
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): Promise<void> {
    return this.receiver.handle(req, res);
  }

  @Post(INGEST_LOGS_PATH)
  receiveLogs(
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): Promise<void> {
    return this.receiver.handleLogs(req, res);
  }

  /** Issue #18 (D-105): answers `404` unless `NESTRIX_METRICS=on`. */
  @Post(INGEST_METRICS_PATH)
  receiveMetrics(
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): Promise<void> {
    return this.receiver.handleMetrics(req, res);
  }
}
