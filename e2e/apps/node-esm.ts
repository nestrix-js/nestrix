import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { type NestNodeApplication, NodeAdapter } from "@nestjs/platform-node";
import { NestrixModule } from "@nestrix-js/nestjs";
import { AppModule } from "node-esm/app.module";

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

// platform-node is not selected by an import: the adapter instance is passed to
// NestFactory.create, otherwise Nest falls back to Express.
// No top-level await.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestNodeApplication>(
    RootModule,
    new NodeAdapter(),
  );
  if (process.env.E2E_PREFIX) app.setGlobalPrefix(process.env.E2E_PREFIX);
  if (process.env.E2E_SECURITY_HEADERS) app.useSecurityHeaders();
  if (process.env.E2E_CORS) app.enableCors({ origin: true, credentials: true });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
