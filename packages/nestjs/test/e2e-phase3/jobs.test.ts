// P3-08 acceptance (roadmap phase 3): one request runs three `pg` queries and enqueues a BullMQ
// job; the queries are children of the right method spans; the job's processing, with the
// processor's `process` method span under it, is found in the trace. Real Postgres 18 and Redis 8.
import "reflect-metadata";
import { createRequire } from "node:module";
import { BullModule, InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Controller, Get, Inject, Injectable, Module } from "@nestjs/common";
import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type { Job, Queue } from "bullmq";
import { BullMQOtel } from "bullmq-otel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestrixInstrument } from "../../src/methods/instrument.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import {
  address,
  parentId,
  skipReason,
  waitUntil,
} from "../integrations/helpers.js";
import {
  BASE_OPTIONS,
  bootInstrumented,
  type Instrumented,
  resetSpans,
  setupTracing,
  spans,
  waitFor,
} from "../methods/helpers.js";

const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: pg is untyped here on purpose (structural use only)
const pg = require("pg") as any;

const reason = skipReason("postgres") ?? skipReason("redis");
setupTracing();

const PG = reason === undefined ? address("postgres") : undefined;
const REDIS = reason === undefined ? address("redis") : undefined;

@Injectable()
class OrderRepository {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  readonly pool: any =
    PG === undefined
      ? undefined
      : new pg.Pool({
          host: PG.host,
          port: PG.port,
          user: "postgres",
          database: "nestrix",
        });
  async load(): Promise<number> {
    await this.pool.query("SELECT 1 AS one");
    await this.pool.query("SELECT 2 AS two");
    await this.pool.query("SELECT 3 AS three");
    return 3;
  }
}

@Injectable()
class OrderService {
  constructor(
    @Inject(OrderRepository) private readonly repo: OrderRepository,
    @InjectQueue("emails") private readonly queue: Queue,
  ) {}
  async place(): Promise<string> {
    await this.repo.load();
    const job = await this.queue.add("welcome", { order: 1 });
    return String(job.id);
  }
}

@Controller("orders")
class OrderController {
  constructor(@Inject(OrderService) private readonly orders: OrderService) {}
  @Get()
  place(): Promise<string> {
    return this.orders.place();
  }
}

@Processor("emails")
class EmailProcessor extends WorkerHost {
  async process(job: Job): Promise<string> {
    return `sent:${job.name}`;
  }
}

@Module({
  imports: [
    BullModule.forRoot({
      connection: REDIS ?? { host: "127.0.0.1", port: 6379 },
      telemetry: new BullMQOtel({ tracerName: "nestrix-e2e" }),
    }),
    BullModule.registerQueue({ name: "emails" }),
    NestrixModule.forRoot(BASE_OPTIONS),
  ],
  controllers: [OrderController],
  providers: [OrderRepository, OrderService, EmailProcessor],
})
class JobsApp {}

describe.skipIf(reason !== undefined)(
  "request -> 3 pg queries -> BullMQ job",
  () => {
    let app: Instrumented;

    beforeAll(async () => {
      await waitUntil(
        async () => {
          const c = new pg.Client({
            host: PG?.host,
            port: PG?.port,
            user: "postgres",
            database: "nestrix",
          });
          await c.connect();
          await c.end();
        },
        30_000,
        "postgres",
      );
      app = await bootInstrumented("express", JobsApp, NestrixInstrument);
    }, 45_000);

    afterAll(async () => {
      await app?.app.get(OrderRepository).pool?.end();
      await app?.close();
    });

    it("one trace: server span, method spans, three pg spans, BullMQ producer, job processing, processor method", async () => {
      resetSpans();
      const res = await app.get("/orders");
      expect(res.status).toBe(200);
      await waitFor(
        () => spans().some((s) => s.name === "EmailProcessor.process"),
        15_000,
      );
      await waitFor(
        () => spans().some((s) => s.name === "process emails"),
        5_000,
      );

      const one = (pred: (s: ReadableSpan) => boolean): ReadableSpan => {
        const found = spans().filter(pred);
        expect(found).toHaveLength(1);
        return found[0] as ReadableSpan;
      };
      const nestrix = (name: string) =>
        one(
          (s) =>
            s.name === name &&
            s.instrumentationScope.name === "@nestrix-js/nestjs",
        );
      const server = one((s) => s.name === "GET /orders");
      const controller = nestrix("OrderController.place");
      const service = nestrix("OrderService.place");
      const repository = nestrix("OrderRepository.load");
      const id = (s: ReadableSpan) => s.spanContext().spanId;

      // The request's own chain.
      expect(server.kind).toBe(SpanKind.SERVER);
      expect(server.parentSpanContext).toBeUndefined();
      expect(parentId(controller)).toBe(id(server));
      expect(parentId(service)).toBe(id(controller));
      expect(parentId(repository)).toBe(id(service));

      // Three pg spans, each a child of the repository method that ran the query.
      const queries = spans().filter(
        (s) => s.attributes["db.system.name"] === "postgresql",
      );
      expect(queries.map((q) => q.attributes["db.query.text"])).toEqual([
        "SELECT ? AS one",
        "SELECT ? AS two",
        "SELECT ? AS three",
      ]);
      for (const q of queries) {
        expect(q.kind).toBe(SpanKind.CLIENT);
        expect(parentId(q)).toBe(id(repository));
      }

      // BullMQ's producer span is a child of the service method that called queue.add().
      const producer = one((s) => s.name === "add emails.welcome");
      expect(producer.kind).toBe(SpanKind.PRODUCER);
      expect(parentId(producer)).toBe(id(service));

      // Found shape: BullMQ's `process` span is a CHILD of the producer span, in the same trace
      // (the context travels in the job's `telemetry.metadata`), with no link; the processor's
      // `process` method span is its child and an entry method (`nestrix.entry: 'job'`).
      const processing = one((s) => s.name === "process emails");
      expect(processing.kind).toBe(SpanKind.CONSUMER);
      expect(parentId(processing)).toBe(id(producer));
      expect(processing.links).toEqual([]);
      const method = nestrix("EmailProcessor.process");
      expect(parentId(method)).toBe(id(processing));
      expect(method.attributes["nestrix.entry"]).toBe("job");
      expect(method.attributes["nestrix.component"]).toBe("processor");
      expect(method.links).toEqual([]);

      const traceId = server.spanContext().traceId;
      for (const s of [
        controller,
        service,
        repository,
        producer,
        processing,
        method,
        ...queries,
      ]) {
        expect(s.spanContext().traceId).toBe(traceId);
      }
    }, 30_000);
  },
);
