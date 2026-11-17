import "reflect-metadata";
import { InjectQueue } from "@nestjs/bullmq";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { type NestNodeApplication, NodeAdapter } from "@nestjs/platform-node";
import { NestrixInstrument } from "@nestrix-js/nestjs";
import type { Queue } from "bullmq";
import { JobsModule, QUEUE } from "./jobs.module.js";

@Controller()
class JobsController {
  constructor(@InjectQueue(QUEUE) private readonly queue: Queue) {}

  // Queues a job the worker completes.
  @Get("ok")
  async ok(): Promise<string> {
    return String((await this.queue.add("email", { to: 1 })).id);
  }

  // Queues a job the worker's processor throws for.
  @Get("fail")
  async fail(): Promise<string> {
    return String((await this.queue.add("boom", { to: 2 })).id);
  }
}

@Module({ imports: [JobsModule], controllers: [JobsController] })
class ApiModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestNodeApplication>(
    ApiModule,
    new NodeAdapter(),
    { instrument: NestrixInstrument, logger: ["error", "warn"] },
  );
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 0), "127.0.0.1");
  process.stdout.write(`listening ${await app.getUrl()}\n`);
}

void bootstrap();
