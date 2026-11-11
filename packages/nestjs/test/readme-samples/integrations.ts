import { Module } from "@nestjs/common";
import { NestrixModule } from "../../src/index.js";

@Module({
  imports: [
    NestrixModule.forRoot({
      integrations: {
        pg: true, // the default; false turns it off
        mysql2: true, // opt-in: mysql2 then swallows unhandled query errors
        ioredis: { rootSpans: false }, // opt-in; true keeps commands outside any trace
      },
    }),
  ],
})
export class AppModule {}
