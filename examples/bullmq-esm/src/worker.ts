import "reflect-metadata";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestrixInstrument } from "@nestrix-js/nestjs";
import type { Job } from "bullmq";
import { JobsModule, QUEUE } from "./jobs.module.js";

@Processor(QUEUE)
class JobsProcessor extends WorkerHost {
  async process(job: Job): Promise<string> {
    if (job.name === "boom") throw new Error("boom: the job failed on purpose");
    return "sent";
  }
}

@Module({ imports: [JobsModule], providers: [JobsProcessor] })
class WorkerModule {}

// A separate worker process: no HTTP adapter, BullMQ workers only.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    instrument: NestrixInstrument,
    logger: ["error", "warn"],
  });
  app.enableShutdownHooks();
  process.stdout.write("ready\n");
}

void bootstrap();
