// Global state: no host SDK, so Nestrix owns the provider. Issue #43 acceptance (D-100) on all
// three adapters: at sampleRate 0.1 every 5xx and every request slower than the threshold is
// exported in full, the rest at about 10%, and every exported server span carries the keep
// probability (issue #30). Spans arrive over OTLP at a real receiver.
import "reflect-metadata";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
} from "@nestjs/common";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import { NestrixInstrument } from "../src/methods/instrument.js";
import { NestrixModule } from "../src/nestrix.module.js";
import { ATTR_SAMPLING_PROBABILITY } from "../src/tail-sampling.js";
import { ADAPTERS, bootInstrumented } from "./methods/helpers.js";
import { type Receiver, startReceiver } from "./otel-helpers.js";

let receiver: Receiver;
beforeAll(async () => {
  receiver = await startReceiver();
});
afterAll(async () => {
  await receiver.close();
});
afterEach(() => {
  receiver.spans.length = 0;
  resetDiagnosticsForTests();
});

@Injectable()
class WorkService {
  run(id: string): string {
    return id;
  }
  fail(): never {
    throw new Error("boom");
  }
}

@Controller("t")
class TailController {
  constructor(@Inject(WorkService) private readonly work: WorkService) {}

  @Get("ok/:id")
  ok(@Param("id") id: string): string {
    return this.work.run(id);
  }

  @Get("boom/:id")
  boom(): never {
    return this.work.fail();
  }

  @Get("missing/:id")
  missing(): never {
    throw new NotFoundException();
  }

  @Get("slow/:id")
  async slow(@Param("id") id: string): Promise<string> {
    await new Promise((r) => setTimeout(r, 600));
    return this.work.run(id);
  }
}

function appModule() {
  @Module({
    imports: [
      NestrixModule.forRoot({
        export: {
          otlp: { endpoint: receiver.url.replace(/\/v1\/traces$/, "") },
          queue: {
            maxQueueSize: 20_000,
            maxExportBatchSize: 512,
            scheduledDelayMillis: 20,
          },
        },
        ui: false,
        metrics: false,
        sampleRate: 0.1,
        sampling: { keepSlowerThanMs: 400 },
      }),
    ],
    controllers: [TailController],
    providers: [WorkService],
  })
  class TailApp {}
  return TailApp;
}

async function sendAll(
  get: (path: string) => Promise<{ status: number }>,
  paths: string[],
  concurrency = 16,
): Promise<number[]> {
  const statuses: number[] = new Array(paths.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < paths.length) {
      const i = next++;
      statuses[i] = (await get(paths[i] as string)).status;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return statuses;
}

describe.each(ADAPTERS)("tail decision at sampleRate 0.1 on %s", (adapter) => {
  it("exports every 5xx and slow request in full, about 10% of the rest, with the keep probability", async () => {
    const booted = await bootInstrumented(
      adapter,
      appModule(),
      NestrixInstrument,
    );
    const paths: string[] = [];
    for (let i = 0; i < 300; i++) paths.push(`/t/ok/${i}`);
    for (let i = 0; i < 40; i++) paths.push(`/t/boom/${i}`);
    for (let i = 0; i < 60; i++) paths.push(`/t/missing/${i}`);
    for (let i = 0; i < 10; i++) paths.push(`/t/slow/${i}`);
    let statuses: number[];
    try {
      statuses = await sendAll(booted.get, paths);
    } finally {
      // Shutdown flushes what was handed to the batch processor.
      await booted.close();
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(310);
    expect(statuses.filter((s) => s === 500)).toHaveLength(40);
    expect(statuses.filter((s) => s === 404)).toHaveLength(60);

    const servers = receiver.spans.filter(
      (s) => s.parentSpanId === undefined && s.attributes["url.path"],
    );
    const byPrefix = (prefix: string) =>
      servers.filter((s) =>
        String(s.attributes["url.path"]).startsWith(prefix),
      );

    // Every failed request, in full: server span, controller span and the failing service span.
    const boom = byPrefix("/t/boom/");
    expect(boom).toHaveLength(40);
    for (const root of boom) {
      expect(root.attributes[ATTR_SAMPLING_PROBABILITY]).toBe(1);
      const names = receiver.spans
        .filter((s) => s.traceId === root.traceId && s !== root)
        .map((s) => s.name)
        .sort();
      expect(names).toEqual(["TailController.boom", "WorkService.fail"]);
    }

    // Every slow request, in full.
    const slow = byPrefix("/t/slow/");
    expect(slow).toHaveLength(10);
    for (const root of slow) {
      expect(root.attributes[ATTR_SAMPLING_PROBABILITY]).toBe(1);
      expect(
        receiver.spans.filter((s) => s.traceId === root.traceId),
      ).toHaveLength(3);
    }

    // The rest at the ratio. Binomial(300, 0.1): mean 30, sd about 5.2; the bounds are > 4 sd.
    // On a loaded machine a fast route can still pass the slow threshold: such a request is kept
    // with probability 1 by the slow rule, so only the ratio's share is counted against the bounds.
    const ratioKept = (roots: typeof servers) =>
      roots.filter((s) => s.attributes[ATTR_SAMPLING_PROBABILITY] === 0.1);
    const ok = byPrefix("/t/ok/");
    for (const root of ok) {
      expect([0.1, 1]).toContain(root.attributes[ATTR_SAMPLING_PROBABILITY]);
      expect(
        receiver.spans.filter((s) => s.traceId === root.traceId),
      ).toHaveLength(3);
    }
    expect(ratioKept(ok).length).toBeGreaterThanOrEqual(8);
    expect(ratioKept(ok).length).toBeLessThanOrEqual(55);
    // A 404 is an expected exception (D-94): not kept by the error rule. Binomial(60, 0.1).
    const missing = byPrefix("/t/missing/");
    for (const root of missing) {
      expect([0.1, 1]).toContain(root.attributes[ATTR_SAMPLING_PROBABILITY]);
    }
    expect(ratioKept(missing).length).toBeLessThanOrEqual(20);

    // Nothing but these traces' spans was exported: dropped traces left no orphans behind.
    const kept = new Set(servers.map((s) => s.traceId));
    expect(receiver.spans.every((s) => kept.has(s.traceId))).toBe(true);
    expect([...getFailureCounts().keys()]).toEqual([]);
  });
});
