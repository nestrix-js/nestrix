import { BullModule, Processor, WorkerHost } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { BullMQOtel } from "bullmq-otel";
import { NestrixModule } from "../../src/index.js";

@Processor("emails")
export class EmailProcessor extends WorkerHost {
  // With `NestrixInstrument` in main.ts, `process` gets a span named "EmailProcessor.process".
  async process(): Promise<void> {}
}

@Module({
  imports: [
    BullModule.forRoot({
      connection: { host: "localhost", port: 6379 },
      // The one line: BullMQ records its own spans and carries the trace context in each job.
      telemetry: new BullMQOtel({ tracerName: "my-app" }),
    }),
    BullModule.registerQueue({ name: "emails" }),
    NestrixModule.forRoot(),
  ],
  providers: [EmailProcessor],
})
export class AppModule {}
