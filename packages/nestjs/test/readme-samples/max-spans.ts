import { Module } from "@nestjs/common";
import { NestrixModule } from "../../src/index.js";

@Module({
  imports: [
    NestrixModule.forRoot({
      // At most 5,000 spans per trace in this process; the rest are counted on the root span.
      maxSpansPerTrace: 5_000,
    }),
  ],
})
export class AppModule {}
