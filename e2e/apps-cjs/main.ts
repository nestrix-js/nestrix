import "reflect-metadata";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { NestrixModule } from "@nestrix-js/nestjs";
import { ExpressAppModule } from "express-cjs/express-app.module";

// The end-to-end suite picks a variant of this app with environment variables:
//   E2E_PREFIX=api          global prefix        E2E_SECURITY_HEADERS=1  app.useSecurityHeaders()
//   E2E_CORS=1              host CORS            E2E_SAMPLE_RATE=0.1     Nestrix sampleRate
//   E2E_CATCH_ALL=1         a host catch-all route
// With none of them set this is the example app plus NestrixModule: the dashboard in its default auto mode.

@Controller()
class CatchAllController {
  @Get("*splat")
  all(): string {
    return "host-catch-all";
  }
}

const sampleRate = process.env.E2E_SAMPLE_RATE;

@Module({
  imports: [
    ExpressAppModule,
    NestrixModule.forRoot({
      export: { otlp: false },
      ...(sampleRate ? { sampleRate: Number(sampleRate) } : {}),
    }),
  ],
  controllers: process.env.E2E_CATCH_ALL ? [CatchAllController] : [],
})
class RootModule {}

// No top-level await.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(RootModule);
  if (process.env.E2E_PREFIX) app.setGlobalPrefix(process.env.E2E_PREFIX);
  if (process.env.E2E_SECURITY_HEADERS) app.useSecurityHeaders();
  if (process.env.E2E_CORS) app.enableCors({ origin: true, credentials: true });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
