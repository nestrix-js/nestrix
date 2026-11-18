// D-93, D-94 with a real BullMQ worker and Redis 8: a failed job attempt is one error occurrence
// (the processor's method span; BullMQ's "job failed" event on the `process` span is matched by
// message inside its own attempt and marked propagated), a retry and a sibling job in the same
// trace with the same message each count, and a job that fails on a 4xx is still a failure.
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { BullModule, InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Controller, Get, Module, NotFoundException } from "@nestjs/common";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type { Job, Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { heldAttemptsForTests } from "../../src/errors/exception.js";
import { bullmqTelemetry } from "../../src/jobs/bullmq.js";
import { NestrixInstrument } from "../../src/methods/instrument.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import {
  isErrorOccurrence,
  isFailedSpan,
} from "../../src/store/error-facts.js";
import { address, skipReason } from "../integrations/helpers.js";
import {
  BASE_OPTIONS,
  bootInstrumented,
  type Instrumented,
  resetSpans,
  setupTracing,
  spans,
  waitFor,
} from "../methods/helpers.js";

const reason = skipReason("redis");
setupTracing();
const REDIS = reason === undefined ? address("redis") : undefined;
const QUEUE = `failing-${randomUUID().slice(0, 8)}`;

@Controller("jobs")
class JobsController {
  constructor(@InjectQueue(QUEUE) private readonly queue: Queue) {}

  /** Two sibling jobs in this request's trace, failing with the same message, two attempts each. */
  @Get("two")
  async two(): Promise<string> {
    await this.queue.add("smtp", { kind: "smtp" }, { attempts: 2 });
    await this.queue.add("smtp", { kind: "smtp" }, { attempts: 2 });
    return "queued";
  }

  @Get("missing")
  async missing(): Promise<string> {
    await this.queue.add("lookup", { kind: "missing" });
    return "queued";
  }
}

@Processor(QUEUE)
class FailingProcessor extends WorkerHost {
  async process(job: Job): Promise<string> {
    if (job.data.kind === "missing")
      throw new NotFoundException("no such user");
    throw new Error("SMTP down");
  }
}

@Module({
  imports: [
    BullModule.forRoot({
      connection: REDIS ?? { host: "127.0.0.1", port: 6379 },
      telemetry: bullmqTelemetry({ tracerName: "nestrix-e2e" }),
    }),
    BullModule.registerQueue({ name: QUEUE }),
    NestrixModule.forRoot(BASE_OPTIONS),
  ],
  controllers: [JobsController],
  providers: [FailingProcessor],
})
class JobsErrorsApp {}

const statusOf = (s: ReadableSpan) =>
  s.status.code === 2 ? "error" : s.status.code === 1 ? "ok" : "unset";
const eventsOf = (s: ReadableSpan) =>
  s.events.map((e) => ({ name: e.name, attributes: e.attributes ?? {} }));
const occurrences = (traceId: string) =>
  spans().filter(
    (s) =>
      s.spanContext().traceId === traceId &&
      isErrorOccurrence(statusOf(s), eventsOf(s)),
  );
const traceOf = (route: string) =>
  spans()
    .find((s) => s.name === `GET /jobs/${route}`)
    ?.spanContext().traceId;
const named = (traceId: string | undefined, name: string) =>
  spans().filter((s) => s.spanContext().traceId === traceId && s.name === name);

describe.skipIf(reason !== undefined)("BullMQ job failures", () => {
  let app: Instrumented;

  beforeAll(async () => {
    app = await bootInstrumented("express", JobsErrorsApp, NestrixInstrument);
  }, 45_000);
  afterAll(async () => {
    await app?.close();
  });

  it("each failed attempt is one occurrence, retries and siblings with one message included", async () => {
    resetSpans();
    expect((await app.get("/jobs/two")).status).toBe(200);
    await waitFor(
      () => named(traceOf("two"), `process ${QUEUE}`).length === 4,
      20_000,
    );
    const traceId = traceOf("two") as string;
    const consumers = named(traceId, `process ${QUEUE}`);
    for (const consumer of consumers) {
      expect(statusOf(consumer)).toBe("error");
      const failed = consumer.events.filter((e) => e.name === "exception");
      expect(failed).toHaveLength(1);
      expect(failed[0]?.attributes?.["exception.message"]).toBe("SMTP down");
      expect(failed[0]?.attributes?.["nestrix.exception.propagated"]).toBe(
        true,
      );
    }
    const found = occurrences(traceId);
    expect(found.map((s) => s.name)).toEqual(
      Array(4).fill("FailingProcessor.process"),
    );
    // Each attempt's messages are dropped when its span ends.
    expect(heldAttemptsForTests()).toBe(0);
  }, 30_000);

  it("a job that fails on a 4xx is still a failure, counted once", async () => {
    resetSpans();
    expect((await app.get("/jobs/missing")).status).toBe(200);
    await waitFor(
      () => named(traceOf("missing"), `process ${QUEUE}`).length === 1,
      20_000,
    );
    const traceId = traceOf("missing") as string;
    const found = occurrences(traceId);
    expect(found.map((s) => s.name)).toEqual(["FailingProcessor.process"]);
    const method = found[0] as ReadableSpan;
    expect(
      method.events[0]?.attributes?.["nestrix.exception.expected"],
    ).toBeUndefined();
    const consumer = named(traceId, `process ${QUEUE}`)[0] as ReadableSpan;
    expect(isFailedSpan(statusOf(consumer), eventsOf(consumer))).toBe(true);
  }, 30_000);
});

describe.skipIf(reason !== undefined)(
  "BullMQ job failures without method spans",
  () => {
    let app: Instrumented;

    beforeAll(async () => {
      app = await bootInstrumented("express", JobsErrorsApp);
    }, 45_000);
    afterAll(async () => {
      await app?.close();
    });

    it("each attempt's own job failed event is the occurrence; a retry with the same message is not merged", async () => {
      resetSpans();
      expect((await app.get("/jobs/two")).status).toBe(200);
      await waitFor(
        () => named(traceOf("two"), `process ${QUEUE}`).length === 4,
        20_000,
      );
      const found = occurrences(traceOf("two") as string);
      expect(found.map((s) => s.name)).toEqual(
        Array(4).fill(`process ${QUEUE}`),
      );
      for (const s of found) {
        expect(
          s.events.find((e) => e.name === "exception")?.attributes?.[
            "nestrix.exception.propagated"
          ],
        ).toBeUndefined();
      }
    }, 30_000);

    it("a job failing on a 4xx counts", async () => {
      resetSpans();
      expect((await app.get("/jobs/missing")).status).toBe(200);
      await waitFor(
        () => named(traceOf("missing"), `process ${QUEUE}`).length === 1,
        20_000,
      );
      expect(occurrences(traceOf("missing") as string)).toHaveLength(1);
    }, 30_000);
  },
);
