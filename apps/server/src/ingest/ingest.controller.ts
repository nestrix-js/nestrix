import type { IncomingMessage, ServerResponse } from "node:http";
import { Controller, Post, Req, Res } from "@nestjs/common";
import { IngestReceiver } from "./receiver.js";
import { INGEST_LOGS_PATH, INGEST_TRACES_PATH } from "./tokens.js";

/**
 * `POST /v1/traces` and `POST /v1/logs`. `@Res()` hands the raw response to the receiver, which
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
}
