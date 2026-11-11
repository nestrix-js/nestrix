// Q5: do @nestjs/schedule (@Cron / @Interval) and @nestjs/bullmq (@Processor) call the wrapped method?
// BullMQ needs Redis: set S6_REDIS_URL (e.g. redis://127.0.0.1:32771). Without it, or when it is
// unreachable, the BullMQ tests are skipped with a message.
import "reflect-metadata";
import { connect } from "node:net";
import {
  BullModule,
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from "@nestjs/bullmq";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Job, Queue } from "bullmq";
import { createClient } from "redis";
import { describe, expect, it } from "vitest";
import { ScheduleFixtureModule, TickService } from "../src/app/fixtures.ts";
import { classify, ruleMarkers } from "../src/rules.ts";
import { setupTracing } from "../src/tracing.ts";
import {
  type CopyOptions,
  createInstanceDecorator,
  isWrapper,
  type Strategy,
} from "../src/wrap.ts";

const exporter = setupTracing();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_METADATA: CopyOptions = {
  metadata: false,
  ownProps: false,
  name: true,
  length: true,
};

describe("Q5 @nestjs/schedule", () => {
  for (const strategy of ["own", "proto"] as Strategy[]) {
    it(`${strategy}: @Interval and @Cron run the wrapped method (spans recorded)`, async () => {
      TickService.intervalRuns = 0;
      TickService.cronRuns = 0;
      exporter.reset();
      const instanceDecorator = createInstanceDecorator({
        strategy,
        shouldWrapClass: ruleMarkers,
      });
      const app = await NestFactory.createApplicationContext(
        ScheduleFixtureModule,
        {
          logger: false,
          abortOnError: false,
          instrument: { instanceDecorator },
        },
      );
      try {
        await app.init();
        expect(isWrapper(app.get(TickService).tick)).toBe(true);
        await sleep(1300);
      } finally {
        await app.close();
      }
      const names = exporter.getFinishedSpans().map((s) => s.name);
      console.log(
        `Q5 schedule ${strategy}: intervalRuns=${TickService.intervalRuns} cronRuns=${TickService.cronRuns} tick spans=${names.filter((n) => n === "TickService.tick").length} cron spans=${names.filter((n) => n === "TickService.everySecond").length}`,
      );
      expect(TickService.intervalRuns).toBeGreaterThan(5);
      expect(TickService.cronRuns).toBeGreaterThanOrEqual(1);
      expect(names.filter((n) => n === "TickService.tick").length).toBe(
        TickService.intervalRuns,
      );
      expect(names.filter((n) => n === "TickService.everySecond").length).toBe(
        TickService.cronRuns,
      );
    });

    it(`${strategy}: a wrapper without the metadata silently unschedules the job`, async () => {
      TickService.intervalRuns = 0;
      const instanceDecorator = createInstanceDecorator({
        strategy,
        shouldWrapClass: ruleMarkers,
        copy: NO_METADATA,
      });
      const app = await NestFactory.createApplicationContext(
        ScheduleFixtureModule,
        {
          logger: false,
          abortOnError: false,
          instrument: { instanceDecorator },
        },
      );
      try {
        await app.init();
        await sleep(200);
      } finally {
        await app.close();
      }
      console.log(
        `Q5 schedule ${strategy} without metadata: intervalRuns=${TickService.intervalRuns}`,
      );
      expect(TickService.intervalRuns).toBe(0);
    });
  }
});

// ---------- BullMQ ----------

const REDIS_URL = process.env.S6_REDIS_URL;

async function reachable(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = connect({ host: u.hostname, port: Number(u.port || 6379) });
    s.setTimeout(500);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
    s.once("timeout", () => {
      s.destroy();
      resolve(false);
    });
  });
}

const redisUp = await reachable(REDIS_URL);
if (!redisUp) {
  console.warn(
    `Q5 BullMQ tests SKIPPED: Redis ${REDIS_URL ? `at ${REDIS_URL} is unreachable` : "not configured (set S6_REDIS_URL=redis://127.0.0.1:<port>)"}`,
  );
}

const processed: unknown[] = [];
const completed: string[] = [];

function makeModule(queueName: string, client: unknown) {
  @Processor(queueName)
  class S6Processor extends WorkerHost {
    async process(job: Job): Promise<string> {
      processed.push(job.data);
      return "done";
    }
    @OnWorkerEvent("completed")
    onCompleted(job: Job) {
      completed.push(String(job.id));
    }
  }

  @Injectable()
  class Producer {
    constructor(@InjectQueue(queueName) readonly queue: Queue) {}
    add(data: unknown) {
      return this.queue.add("job", data);
    }
  }

  @Module({
    imports: [
      // A connected node-redis client: BullMQ 6 adapts it, so the spike needs no ioredis (adding
      // ioredis changed how the workspace resolves @nestjs/microservices' optional ioredis peer).
      BullModule.forRoot({ connection: client as never }),
      BullModule.registerQueue({ name: queueName }),
    ],
    providers: [S6Processor, Producer],
  })
  class BullFixtureModule {}

  return { BullFixtureModule, S6Processor, Producer };
}

/** Wraps classes with Nest's markers, plus BullMQ processors (WorkerHost subclasses), which carry neither. */
const markersOrWorkerHost = (info: {
  instance: object;
  ctor: unknown;
  proto: object;
}) => ruleMarkers(info) || info.instance instanceof WorkerHost;

describe.skipIf(!redisUp)("Q5 @nestjs/bullmq", () => {
  for (const strategy of ["own", "proto"] as Strategy[]) {
    for (const rule of ["markers", "markers+WorkerHost"] as const) {
      it(`${strategy} / ${rule}: @Processor.process and @OnWorkerEvent`, async () => {
        processed.length = 0;
        completed.length = 0;
        exporter.reset();
        const queueName = `s6-${strategy}-${rule.replace("+", "-")}-${process.pid}`;
        const client = createClient({ url: REDIS_URL });
        await client.connect();
        const { BullFixtureModule, S6Processor, Producer } = makeModule(
          queueName,
          client,
        );
        const instanceDecorator = createInstanceDecorator({
          strategy,
          shouldWrapClass:
            rule === "markers" ? ruleMarkers : markersOrWorkerHost,
        });
        const app = await NestFactory.createApplicationContext(
          BullFixtureModule,
          {
            logger: false,
            abortOnError: false,
            instrument: { instanceDecorator },
          },
        );
        try {
          await app.init();
          const proc = app.get(S6Processor);
          const c = classify(proc);
          await app.get(Producer).add({ n: 1 });
          for (let i = 0; i < 100 && completed.length === 0; i++)
            await sleep(50);
          const names = exporter.getFinishedSpans().map((s) => s.name);
          console.log(
            `Q5 bullmq ${strategy}/${rule}: processor injectable=${c.injectable} wrapped=${isWrapper(proc.process)} processed=${JSON.stringify(processed)} completed=${completed.length} spans=${JSON.stringify(names.filter((n) => n.startsWith("S6Processor")))}`,
          );
          expect(processed).toEqual([{ n: 1 }]);
          expect(completed).toHaveLength(1);
          expect(c.injectable).toBe(false); // @Processor sets no @Injectable watermark
          if (rule === "markers") {
            expect(names.filter((n) => n.startsWith("S6Processor"))).toEqual(
              [],
            );
          } else {
            expect(names).toContain("S6Processor.process");
            expect(names).toContain("S6Processor.onCompleted");
          }
          await app.get(Producer).queue.obliterate({ force: true });
        } finally {
          await app.close();
          await client.quit().catch(() => {});
        }
      }, 15000);
    }
  }
});
