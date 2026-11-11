import { NestFactory } from "@nestjs/core";
import { NestrixInstrument } from "../../src/index.js";
import { AppModule } from "./for-root.js";

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Level 2: lets Nestrix wrap your own classes' methods as they are created.
    instrument: NestrixInstrument,
  });
  await app.listen(3000);
}
