import { NestFactory } from "@nestjs/core";
import { NestrixLogger } from "../../src/index.js";
import { AppModule } from "./for-root.js";

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: new NestrixLogger(),
  });
  await app.listen(3000);
}
