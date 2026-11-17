import { bullmqTelemetry } from "@nestrix-js/nestjs";
import type { Telemetry } from "bullmq";
import { BullMQOtel } from "bullmq-otel";

// Which BullMQ telemetry the fixture uses, from BULLMQ_TELEMETRY. Called when jobs.module.ts is
// imported, exactly like `telemetry: ...` written inline in `BullModule.forRoot()`.
export function telemetryFromEnv(): Telemetry {
  const mode = process.env.BULLMQ_TELEMETRY ?? "nestrix";
  switch (mode) {
    // The documented setup (README "Background jobs (BullMQ)").
    case "nestrix":
      return bullmqTelemetry({ tracerName: "fixture" });
    // The documented note for apps that keep bullmq-otel: create it on first use.
    case "bullmq-otel-lazy": {
      let otel: BullMQOtel | undefined;
      const lazy = () => (otel ??= new BullMQOtel({ tracerName: "fixture" }));
      return {
        get tracer() {
          return lazy().tracer;
        },
        get contextManager() {
          return lazy().contextManager;
        },
      };
    }
    // What the docs used to say: in an ESM app, BullMQ's spans are silently missing (issue #20).
    case "bullmq-otel":
      return new BullMQOtel({ tracerName: "fixture" });
    default:
      throw new Error(`unknown BULLMQ_TELEMETRY: ${mode}`);
  }
}
