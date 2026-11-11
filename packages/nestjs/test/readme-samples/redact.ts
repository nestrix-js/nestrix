import { Module } from "@nestjs/common";
import { NestrixModule } from "../../src/index.js";

@Module({
  imports: [
    NestrixModule.forRoot({
      redact: (span) => {
        // Drop a span altogether.
        if (span.name === "GET /internal/debug") return false;

        // Rewrite or delete attributes.
        delete span.attributes["url.query"];

        // Exception messages are stored as they are; rewrite them here.
        for (const event of span.events) {
          if (typeof event.attributes["exception.message"] === "string") {
            event.attributes["exception.message"] = "REDACTED";
          }
        }

        // The status message often repeats the exception message.
        delete span.status.message;
      },
    }),
  ],
})
export class AppModule {}
