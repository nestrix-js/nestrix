import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ExpressAppModule } from "./express-app.module.js";

// No top-level await, so this file is identical in the CommonJS clone.
async function bootstrap(): Promise<void> {
  const app =
    await NestFactory.create<NestExpressApplication>(ExpressAppModule);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
