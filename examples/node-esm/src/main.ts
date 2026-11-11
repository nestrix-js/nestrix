import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { type NestNodeApplication, NodeAdapter } from "@nestjs/platform-node";
import { AppModule } from "./app.module.js";

// platform-node is not selected by an import: the adapter instance is passed to
// NestFactory.create, otherwise Nest falls back to Express.
// No top-level await, so this file is identical in the CommonJS clone.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestNodeApplication>(
    AppModule,
    new NodeAdapter(),
  );
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
