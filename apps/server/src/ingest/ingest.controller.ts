import type { IncomingMessage, ServerResponse } from "node:http";
import { Controller, Post, Req, Res } from "@nestjs/common";
import { IngestReceiver } from "./receiver.js";
import { INGEST_TRACES_PATH } from "./tokens.js";

/**
 * `POST /v1/traces`. `@Res()` hands the raw response to the receiver, which writes it; the body
 * is read from the raw request, so no body parser may run on this path (see `configureApp`).
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
}
