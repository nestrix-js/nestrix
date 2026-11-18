import type { IncomingMessage, Server } from "node:http";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { AdminAuth } from "./auth/admin-auth.js";
import {
  DEFAULT_INGEST,
  type HttpServerConfig,
  type ServerConfig,
} from "./config.js";
import { HealthService, healthMiddleware } from "./health/health.js";
import { INGEST_PATH_PATTERN } from "./ingest/tokens.js";
import { unknownOtlpPathMiddleware } from "./ingest/unknown-path.js";
import { ServerLogger } from "./logging.js";

/**
 * True for the ingest path as Express routes it: case-insensitive, with or without a trailing
 * slash, query string ignored.
 */
export function isIngestRequest(req: IncomingMessage): boolean {
  return INGEST_PATH_PATTERN.test((req.url ?? "").split("?", 1)[0]);
}

function mediaType(req: IncomingMessage): string {
  return (req.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

/**
 * Settings every instance of the server needs, whether built by `createApp` or by a test
 * module, starting with the admin login's middleware. The app must have been created with `bodyParser: false`: the receiver reads the
 * ingest body itself, so the JSON and form parsers registered here skip the ingest path.
 * With `config`, also applies the HTTP server limits (`configureHttpServer`).
 */
export function configureApp(
  app: NestExpressApplication,
  config?: ServerConfig,
): void {
  if (config !== undefined) configureHttpServer(app, config.http);
  app.disable("x-powered-by");
  // #32: `/livez` and `/readyz` first: no credential, no redirect to the login, no limiter.
  app.use(healthMiddleware(app.get(HealthService)));
  // #39: a `/v1/…` path that is not an ingest route (`/v1/metrics`) answers an OTLP 404, before
  // the admin login, so exporters see "not found" instead of 403/503 (src/ingest/unknown-path.ts).
  // Issue #18 (D-105): `/v1/metrics` reaches the receiver only with NESTRIX_METRICS=on.
  app.use(
    unknownOtlpPathMiddleware(
      config?.ingest.discardTimeoutMs ?? DEFAULT_INGEST.discardTimeoutMs,
      config?.metrics.enabled ?? false,
    ),
  );
  // Next, before the body parsers and every Nest route: the admin login's default-deny
  // middleware (src/auth/admin-auth.ts). Throws at start if AuthModule is missing.
  app.use(app.get(AdminAuth).middleware());
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

/**
 * Bounds what slow or numerous clients can hold: the whole request must arrive within
 * `requestTimeoutMs` (headers within `headersTimeoutMs`), and connections beyond
 * `maxConnections` are refused.
 */
export function configureHttpServer(
  app: NestExpressApplication,
  http: HttpServerConfig,
): void {
  const server: Server = app.getHttpServer();
  server.requestTimeout = http.requestTimeoutMs;
  server.headersTimeout = http.headersTimeoutMs;
  server.maxConnections = http.maxConnections;
}

export async function createApp(
  config: ServerConfig,
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(config),
    { bodyParser: false, logger: new ServerLogger(config.log) },
  );
  configureApp(app, config);
  app.enableShutdownHooks();
  return app;
}
