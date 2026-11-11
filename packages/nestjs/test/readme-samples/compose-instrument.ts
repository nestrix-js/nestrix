import { NestFactory } from "@nestjs/core";
import { composeInstrument, NestrixInstrument } from "../../src/index.js";
import { AppModule } from "./for-root.js";

// Another tool's `instrument` object, with the same `instanceDecorator` shape.
declare const otherTool: { instanceDecorator: (instance: unknown) => unknown };

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    instrument: composeInstrument(NestrixInstrument, otherTool),
  });
  await app.listen(3000);
}
