import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { NestrixModule } from "@nestrix/nestjs";
import { AppModule } from "fastify-esm/app.module";

// The end-to-end suite picks a variant of this app with environment variables:
//   E2E_PREFIX=api   global prefix   E2E_SECURITY_HEADERS=1   app.useSecurityHeaders()
//   E2E_CORS=1       host CORS       E2E_SAMPLE_RATE=0.1      Nestrix sampleRate
// With none of them set this is the example app plus NestrixModule: the dashboard in its default auto mode.
const sampleRate = process.env.E2E_SAMPLE_RATE;

@Module({
  imports: [
    AppModule,
    NestrixModule.forRoot({
      export: { otlp: false },
      ...(sampleRate ? { sampleRate: Number(sampleRate) } : {}),
    }),
  ],
})
class RootModule {}

// No top-level await.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    RootModule,
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
  if (process.env.E2E_PREFIX) app.setGlobalPrefix(process.env.E2E_PREFIX);
  if (process.env.E2E_SECURITY_HEADERS) app.useSecurityHeaders();
  // Fastify's CORS hook must run before serialization to reach the dashboard's responses.
  if (process.env.E2E_CORS)
    app.enableCors({
      origin: true,
      credentials: true,
      hook: "preSerialization",
    } as never);
  app.enableShutdownHooks();
  // 127.0.0.1, not the default localhost, which may resolve to IPv6 only.
  await app.listen(Number(process.env.PORT ?? 3000), "127.0.0.1");
}

void bootstrap();
