import { BullModule } from "@nestjs/bullmq";
import type { Telemetry } from "bullmq";
import { BullMQOtel } from "bullmq-otel";

// Built when BullMQ first uses it, after Nestrix has registered its tracer provider.
let otel: BullMQOtel | undefined;
const lazy = () => (otel ??= new BullMQOtel({ tracerName: "my-app" }));
const telemetry: Telemetry = {
  get tracer() {
    return lazy().tracer;
  },
  get contextManager() {
    return lazy().contextManager;
  },
};

export const queues = BullModule.forRoot({
  connection: { host: "localhost", port: 6379 },
  telemetry,
});
