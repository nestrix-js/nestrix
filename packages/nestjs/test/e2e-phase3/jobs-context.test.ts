// Issue #27 acceptance (D-102): a job queued by a tenant's request carries the tenant id in the
// worker. Real Redis 8 (test/integrations/containers.global.ts) and BullMQ with
// `bullmqTelemetry()`. The request's `context` option reads the tenant after the guard ran;
// `contextPropagation.keys` lists `tenant.id` only, so it travels in the job's metadata (stored in
// Redis) as W3C baggage, and the worker sets it on the job's consumer span; `app.plan` stays on
// the request's span. A job the worker queues carries it on.
import "reflect-metadata";
import { BullModule, InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Injectable,
  Module,
  UseGuards,
} from "@nestjs/common";
import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import type { Job, Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bullmqTelemetry } from "../../src/jobs/bullmq.js";
import { NestrixInstrument } from "../../src/methods/instrument.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import {
  address,
  skipReason,
  tcpOpen,
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

const reason = skipReason("redis");
setupTracing();
const REDIS = reason === undefined ? address("redis") : undefined;
const QUEUE = `tenant-mail-${process.pid}`;

@Injectable()
class TenantGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const request = ctx.switchToHttp().getRequest<{
      headers: Record<string, string>;
      tenant?: string;
    }>();
    request.tenant = request.headers["x-tenant"];
    return true;
  }
}

@Controller("signup")
class SignupController {
  constructor(@InjectQueue(QUEUE) private readonly queue: Queue) {}
  @Get()
  @UseGuards(TenantGuard)
  async signup(): Promise<string> {
    const job = await this.queue.add("welcome", { n: 1 });
    return String(job.id);
  }
}

@Processor(QUEUE)
class MailProcessor extends WorkerHost {
  constructor(@InjectQueue(QUEUE) private readonly queue: Queue) {
    super();
  }
  async process(job: Job): Promise<string> {
    if (job.name === "welcome") await this.queue.add("followup", { n: 2 });
    return "sent";
  }
}

@Module({
  imports: [
    BullModule.forRoot({
      connection: REDIS ?? { host: "127.0.0.1", port: 6379 },
      telemetry: bullmqTelemetry({ tracerName: "nestrix-e2e" }),
    }),
    BullModule.registerQueue({ name: QUEUE }),
    NestrixModule.forRoot({
      ...BASE_OPTIONS,
      context: (request) => {
        const r = request as {
          tenant?: string;
          headers: Record<string, string>;
        };
        return { "tenant.id": r.tenant, "app.plan": r.headers["x-plan"] };
      },
      contextPropagation: { keys: ["tenant.id"] },
    }),
  ],
  controllers: [SignupController],
  providers: [MailProcessor],
})
class TenantJobsApp {}

describe.skipIf(reason !== undefined)(
  "tenant id from a request to its jobs",
  () => {
    let app: Instrumented;

    beforeAll(async () => {
      if (REDIS !== undefined)
        await waitUntil(() => tcpOpen(REDIS), 30_000, "redis");
      app = await bootInstrumented("express", TenantJobsApp, NestrixInstrument);
    }, 45_000);

    afterAll(async () => {
      await app?.close();
    });

    it("the request's span has both values; the job's and its follow-up's consumer spans have tenant.id only", async () => {
      resetSpans();
      const res = await fetch(`${app.baseUrl}/signup`, {
        headers: { "x-tenant": "acme", "x-plan": "gold" },
      });
      expect(res.status).toBe(200);
      const jobId = await res.text();
      await waitFor(
        () => spans().filter((s) => s.name === `process ${QUEUE}`).length >= 2,
        15_000,
      );

      const server = spans().find(
        (s) => s.name === "GET /signup",
      ) as ReadableSpan;
      expect(server.attributes["tenant.id"]).toBe("acme");
      expect(server.attributes["app.plan"]).toBe("gold");

      const consumers = spans().filter((s) => s.name === `process ${QUEUE}`);
      expect(consumers).toHaveLength(2);
      for (const c of consumers) {
        expect(c.kind).toBe(SpanKind.CONSUMER);
        expect(c.attributes["tenant.id"]).toBe("acme");
        expect(c.attributes["app.plan"]).toBeUndefined();
        expect(c.spanContext().traceId).toBe(server.spanContext().traceId);
      }

      // What crossed Redis: the job's stored telemetry metadata.
      const queue = app.app.get<Queue>(`BullQueue_${QUEUE}`);
      const job = await queue.getJob(jobId);
      const metadata = JSON.parse(
        String(
          (job?.opts as { telemetry?: { metadata?: string } } | undefined)
            ?.telemetry?.metadata,
        ),
      ) as Record<string, string>;
      expect(metadata.baggage).toBe("tenant.id=acme");
    }, 30_000);
  },
);
