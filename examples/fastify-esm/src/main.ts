import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";

// No top-level await, so this file is identical in the CommonJS clone.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  // Fastify answers 415 to multipart/form-data unless a parser is registered.
  // This one leaves the body unread, so upload.ts reads the raw request.
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser("multipart/form-data", (_req, _payload, done) =>
      done(null),
    );
  app.enableShutdownHooks();
  // 127.0.0.1, not the default localhost, which may resolve to IPv6 only.
  await app.listen(Number(process.env.PORT ?? 3000), "127.0.0.1");
}

void bootstrap();
