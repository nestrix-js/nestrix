import { NestFactory } from "@nestjs/core";
import { AppModule } from "./for-root.js";

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // In a CommonJS app, construct upstream instrumentations (for example
  // new KafkaJsInstrumentation()) here, after NestFactory.create and before listen.
  await app.listen(3000);
}
