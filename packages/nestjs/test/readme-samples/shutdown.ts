import { NestFactory } from "@nestjs/core";
import { AppModule } from "./for-root.js";

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Needed only so SIGTERM and SIGINT close the app, which flushes buffered spans.
  // app.close() flushes without it.
  app.enableShutdownHooks();
  await app.listen(3000);
}
