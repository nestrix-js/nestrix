import type { IncomingMessage } from "node:http";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import type { ServerConfig } from "./config.js";
import { INGEST_TRACES_PATH_PATTERN } from "./ingest/tokens.js";

/**
 * True for the ingest path as Express routes it: case-insensitive, with or without a trailing
 * slash, query string ignored.
 */
export function isIngestRequest(req: IncomingMessage): boolean {
  return INGEST_TRACES_PATH_PATTERN.test((req.url ?? "").split("?", 1)[0]);
}

function mediaType(req: IncomingMessage): string {
  return (req.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

/**
 * Settings every instance of the server needs, whether built by `createApp` or by a test
 * module. The app must have been created with `bodyParser: false`: the receiver reads the
 * ingest body itself, so the JSON and form parsers registered here skip the ingest path.
 */
export function configureApp(app: NestExpressApplication): void {
  app.disable("x-powered-by");
  app.useBodyParser("json", {
    type: (req: IncomingMessage) =>
      !isIngestRequest(req) &&
      (mediaType(req) === "application/json" ||
        mediaType(req).endsWith("+json")),
  });
  app.useBodyParser("urlencoded", {
    extended: false,
    type: (req: IncomingMessage) =>
      !isIngestRequest(req) &&
      mediaType(req) === "application/x-www-form-urlencoded",
  });
}

export async function createApp(
  config: ServerConfig,
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(config),
    { bodyParser: false },
  );
  configureApp(app);
  app.enableShutdownHooks();
  return app;
}
