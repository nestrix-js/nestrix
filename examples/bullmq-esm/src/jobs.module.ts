import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix-js/nestjs";
import { telemetryFromEnv } from "./telemetry.js";

export const QUEUE = process.env.QUEUE ?? "emails";

// Shared by the API (main.ts) and the worker (worker.ts). The OTLP endpoint comes from
// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT; a short batch delay keeps the test that runs this fast.
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? "127.0.0.1",
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
      telemetry: telemetryFromEnv(),
    }),
    BullModule.registerQueue({ name: QUEUE }),
    NestrixModule.forRoot({
      serviceName: process.env.SERVICE_NAME ?? "bullmq-esm",
      export: { queue: { scheduledDelayMillis: 100 } },
    }),
  ],
  exports: [BullModule],
})
export class JobsModule {}
