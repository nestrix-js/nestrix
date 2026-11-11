import { Module } from "@nestjs/common";
import { NestrixModule } from "../../src/index.js";

@Module({
  imports: [
    NestrixModule.forRoot({
      ignore: {
        // A string matches the request path exactly: "/health" does not match "/health/live".
        paths: ["/health", /^\/health\//, (path) => path.endsWith(".map")],
        // A string is a prefix of the recorded url.full. Add your error reporter's ingest host.
        outgoing: ["https://o123.ingest.sentry.io/", /\/internal\//],
      },
    }),
  ],
})
export class AppModule {}
