// P13-01 (D-78), global state: no host SDK, so Nestrix owns the provider and its sampler applies
// `maxSpansPerTrace` to every span (Nestrix's and any other tracer's). Spans arrive over OTLP.
import "reflect-metadata";
import { Processor } from "@nestjs/bullmq";
import { Controller, Get, Inject, Injectable, Module } from "@nestjs/common";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { NestrixInstrument } from "../src/methods/instrument.js";
import { setMethodCallSink } from "../src/methods/sink.js";
import { NestrixModule } from "../src/nestrix.module.js";
import { setupTelemetry } from "../src/otel/setup.js";
import { ClassStatistics } from "../src/stats/class-stats.js";
import {
  ATTR_SPANS_DROPPED,
  installedTraceSpanCounter,
  TraceSpanCounter,
} from "../src/trace-limit.js";
import { bootInstrumented, contextInstrumented } from "./methods/helpers.js";
import {
  config,
  otlp,
  type Receiver,
  recordingDiagnostics,
  startReceiver,
} from "./otel-helpers.js";

let receiver: Receiver;
beforeAll(async () => {
  receiver = await startReceiver();
});
afterAll(async () => {
  await receiver.close();
});
afterEach(() => {
  vi.restoreAllMocks();
  receiver.spans.length = 0;
});

const BIG_QUEUE = {
  maxQueueSize: 16_384,
  maxExportBatchSize: 4_096,
  scheduledDelayMillis: 20,
};

function droppedAttributes(
  attributes: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes ?? {}).filter(([k]) =>
      k.startsWith(ATTR_SPANS_DROPPED),
    ),
  );
}

describe("setupTelemetry with maxSpansPerTrace", () => {
  it("default 10,000: a trace of 25,000 spans exports 10,000, the root carries 15,000", async () => {
    const handle = setupTelemetry(
      config({ export: { otlp: otlp(receiver.url), queue: BIG_QUEUE } }),
      recordingDiagnostics(),
    );
    expect(handle.ownsProvider).toBe(true);
    expect(installedTraceSpanCounter()?.mode).toBe("provider");
    expect(installedTraceSpanCounter()?.counter.limit).toBe(10_000);
    const tracer = trace.getTracer("some-other-instrumentation");
    const root = tracer.startSpan("job");
    const parent = trace.setSpan(ROOT_CONTEXT, root);
    for (let i = 0; i < 24_999; i++) {
      tracer
        .startSpan(
          "SELECT",
          { attributes: { "db.system.name": "postgresql" } },
          parent,
        )
        .end();
    }
    root.end();
    await handle.shutdown();
    expect(installedTraceSpanCounter()).toBeUndefined();
    expect(receiver.spans).toHaveLength(10_000);
    const exportedRoot = receiver.spans.find((s) => s.name === "job");
    expect(droppedAttributes(exportedRoot?.attributes)).toEqual({
      [ATTR_SPANS_DROPPED]: 15_000,
      [`${ATTR_SPANS_DROPPED}.db`]: 15_000,
    });
    expect(handle.counters.droppedSpans).toBe(0);
  });

  it("false: every span is recorded and no counter is installed", async () => {
    const handle = setupTelemetry(
      config({
        maxSpansPerTrace: false,
        export: { otlp: otlp(receiver.url), queue: BIG_QUEUE },
      }),
      recordingDiagnostics(),
    );
    expect(installedTraceSpanCounter()).toBeUndefined();
    const tracer = trace.getTracer("t");
    tracer.startActiveSpan("root", (root) => {
      for (let i = 0; i < 12_000; i++) tracer.startSpan("c").end();
      root.end();
    });
    await handle.shutdown();
    expect(receiver.spans).toHaveLength(12_001);
    expect(
      droppedAttributes(
        receiver.spans.find((s) => s.name === "root")?.attributes,
      ),
    ).toEqual({});
  });
});

// ---- a Nest app: a BullMQ-style job root and an HTTP request root ---------------------------

@Injectable()
class RowService {
  save(i: number): number {
    return i;
  }
}

@Injectable()
class CellService {
  write(): void {}
}

@Injectable()
class RowWithCellsService {
  constructor(@Inject(CellService) private readonly cells: CellService) {}
  save(i: number): number {
    this.cells.write();
    this.cells.write();
    return i;
  }
}

@Processor("p13-nested")
class NestedProcessor {
  constructor(
    @Inject(RowWithCellsService) private readonly rows: RowWithCellsService,
  ) {}
  async process(job: { count: number }): Promise<number> {
    let sum = 0;
    for (let i = 0; i < job.count; i++) sum += this.rows.save(i);
    return sum;
  }
}

@Processor("p13-rows")
class RowProcessor {
  constructor(@Inject(RowService) private readonly rows: RowService) {}
  async process(job: { count: number }): Promise<number> {
    let sum = 0;
    for (let i = 0; i < job.count; i++) {
      sum += this.rows.save(i);
      if (i % 50 === 0) await Promise.resolve();
    }
    return sum;
  }
}

@Controller("rows")
class RowController {
  constructor(@Inject(RowService) private readonly rows: RowService) {}
  @Get()
  list(): string {
    let sum = 0;
    for (let i = 0; i < 250; i++) sum += this.rows.save(i);
    return String(sum);
  }
}

function appModule() {
  @Module({
    imports: [
      NestrixModule.forRoot({
        export: {
          otlp: { endpoint: receiver.url.replace(/\/v1\/traces$/, "") },
          queue: BIG_QUEUE,
        },
        ui: false,
        metrics: false,
        maxSpansPerTrace: 100,
      }),
    ],
    controllers: [RowController],
    providers: [
      RowService,
      RowProcessor,
      CellService,
      RowWithCellsService,
      NestedProcessor,
    ],
  })
  class RowsApp {}
  return RowsApp;
}

const SUM_250 = (249 * 250) / 2;

describe("Nest app owning the provider, maxSpansPerTrace: 100", () => {
  it("a job's processor span is the local root: 100 spans exported, 151 counted on it, class statistics count all 251 calls", async () => {
    const stats = new ClassStatistics();
    const removeSink = setMethodCallSink(stats);
    const app = await contextInstrumented(appModule(), NestrixInstrument);
    try {
      expect(installedTraceSpanCounter()?.mode).toBe("provider");
      const result = await app.get(RowProcessor).process({ count: 250 });
      expect(result).toBe(SUM_250);
    } finally {
      await app.close();
      removeSink();
    }
    const jobSpan = receiver.spans.find(
      (s) => s.name === "RowProcessor.process",
    );
    expect(jobSpan?.parentSpanId).toBeUndefined();
    const traceSpans = receiver.spans.filter(
      (s) => s.traceId === jobSpan?.traceId,
    );
    expect(traceSpans).toHaveLength(100);
    expect(droppedAttributes(jobSpan?.attributes)).toEqual({
      [ATTR_SPANS_DROPPED]: 151,
      [`${ATTR_SPANS_DROPPED}.app`]: 151,
    });
    const classes = stats.query(15, true).classes;
    const methods = Object.fromEntries(
      classes.flatMap((c) =>
        c.methods.map((m) => [`${c.className}.${m.method}`, m.calls]),
      ),
    );
    expect(methods).toMatchObject({
      "RowService.save": 250,
      "RowProcessor.process": 1,
    });
  });

  it("method spans under a dropped method span are skipped by the wrapper and still counted", async () => {
    const app = await contextInstrumented(appModule(), NestrixInstrument);
    try {
      expect(await app.get(NestedProcessor).process({ count: 50 })).toBe(
        (49 * 50) / 2,
      );
    } finally {
      await app.close();
    }
    const job = receiver.spans.find(
      (s) => s.name === "NestedProcessor.process",
    );
    // The job + 33 rows with their 2 cells each = 100; rows 33..49 dropped with their cells: 51.
    expect(
      receiver.spans.filter((s) => s.traceId === job?.traceId),
    ).toHaveLength(100);
    expect(droppedAttributes(job?.attributes)).toEqual({
      [ATTR_SPANS_DROPPED]: 51,
      [`${ATTR_SPANS_DROPPED}.app`]: 51,
    });
  });

  it.each(["express", "fastify", "node"] as const)(
    "%s: the request's server span is the local root and carries the counts",
    async (adapter) => {
      const booted = await bootInstrumented(
        adapter,
        appModule(),
        NestrixInstrument,
      );
      try {
        const res = await booted.get("/rows");
        expect(res).toEqual({ status: 200, body: String(SUM_250) });
      } finally {
        await booted.close();
      }
      const server = receiver.spans.find(
        (s) => s.attributes["url.path"] === "/rows",
      );
      expect(server).toBeDefined();
      const traceSpans = receiver.spans.filter(
        (s) => s.traceId === server?.traceId,
      );
      expect(traceSpans).toHaveLength(100);
      // Server span + controller method span + 98 RowService.save; 152 saves dropped.
      expect(droppedAttributes(server?.attributes)).toEqual({
        [ATTR_SPANS_DROPPED]: 152,
        [`${ATTR_SPANS_DROPPED}.app`]: 152,
      });
    },
  );

  it("fault injection: a counter that throws everywhere changes nothing for the app", async () => {
    for (const method of [
      "tryRecord",
      "dropDescendant",
      "rootEnding",
    ] as const) {
      vi.spyOn(TraceSpanCounter.prototype, method).mockImplementation(() => {
        throw new Error(`injected ${method}`);
      });
    }
    const booted = await bootInstrumented(
      "express",
      appModule(),
      NestrixInstrument,
    );
    try {
      const res = await booted.get("/rows");
      expect(res).toEqual({ status: 200, body: String(SUM_250) });
      expect(await booted.app.get(RowProcessor).process({ count: 120 })).toBe(
        (119 * 120) / 2,
      );
    } finally {
      await booted.close();
    }
    // The limit could not count, so nothing was dropped: the inner sampler's answer stands.
    const server = receiver.spans.find(
      (s) => s.attributes["url.path"] === "/rows",
    );
    expect(
      receiver.spans.filter((s) => s.traceId === server?.traceId),
    ).toHaveLength(252);
  });
});
