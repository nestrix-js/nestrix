import { NestFactory } from "@nestjs/core";
import { Transport } from "@nestjs/microservices";
import { nestrixPreRequestHook } from "../../src/index.js";
import { AppModule } from "./for-root.js";

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app
    .connectMicroservice(
      { transport: Transport.TCP, options: { port: 4000 } },
      // Defers listener registration so the hook below is set in time.
      { deferInitialization: true },
    )
    .registerPreRequestHook(nestrixPreRequestHook);
  await app.startAllMicroservices();
  await app.listen(3000);
}
