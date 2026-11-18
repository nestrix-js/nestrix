import { NestFactory } from "@nestjs/core";
import { nestrixInstrumentIf } from "../../src/index.js";
import { AppModule } from "./for-root.js";

export async function bootstrap(): Promise<void> {
  // Read before Nest builds the app: the same setting your forRootAsync factory uses.
  const tracing = process.env.TRACING !== "off";
  const app = await NestFactory.create(AppModule, {
    // `NestrixInstrument` when true; `undefined` (no instrument at all) when false.
    instrument: nestrixInstrumentIf(tracing),
  });
  await app.listen(3000);
}
