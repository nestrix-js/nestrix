import { Module } from "@nestjs/common";
import { NestrixModule } from "../../src/index.js";

@Module({
  imports: [
    NestrixModule.forRoot({
      export: { otlp: { endpoint: "http://otel-collector:4318" } },
      // The default: the request histogram and runtime metrics. `false` records none.
      metrics: { runtime: true },
    }),
  ],
})
export class AppModule {}
