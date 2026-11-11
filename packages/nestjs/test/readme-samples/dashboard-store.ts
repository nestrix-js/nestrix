import { Module } from "@nestjs/common";
import { NestrixModule } from "../../src/index.js";

@Module({
  imports: [
    NestrixModule.forRoot({
      store: {
        // The dashboard keeps whichever limit is reached first, oldest trace evicted first.
        maxTraces: 500,
        maxBytes: 16 * 1024 * 1024,
      },
    }),
  ],
})
export class AppModule {}
