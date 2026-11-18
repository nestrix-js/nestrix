import { Module } from "@nestjs/common";
import { NestrixModule } from "../../src/index.js";

@Module({
  imports: [
    NestrixModule.forRoot({
      // One in ten traces, plus every failed request and every request slower than 1 s.
      sampleRate: 0.1,
      sampling: { keepErrors: true, keepSlowerThanMs: 1000 },
    }),
  ],
})
export class AppModule {}
