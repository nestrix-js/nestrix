// Issue #38 acceptance in a real Nest app, on all three adapters: a pool of 2 and 10 concurrent
// requests, each one transaction (BEGIN, set_config, a 30 ms query, COMMIT) on `pool.connect()`.
// The waits appear in `db.client.connection.wait_time` and, above 5 ms, as `pg.pool.connect`
// spans in each request's own trace; the request with a free client gets none.
// Global state: a host-owned tracer provider (in-memory exporter), ALS context manager, W3C
// propagator and a host MeterProvider with a pull reader, registered before Nestrix; Nestrix
// installs the pg integration through `NestrixModule.forRoot()`.
import "reflect-metadata";
import { createRequire } from "node:module";
import { Controller, Get, Inject, Module, Param } from "@nestjs/common";
import {
  context,
  metrics,
  propagation,
  SpanKind,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { Histogram } from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PG_POOL_CONNECT_SPAN } from "../../src/integrations/pg-pool.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import { collect, hostMeterProvider, points } from "../metrics/fixture.js";
import { bootOwned } from "../stats-fixture.js";
import {
  address,
  dbSpans,
  durationMs,
  parentId,
  skipReason,
  startMs,
  waitUntil,
} from "./helpers.js";

/** The SDK's anchored clock and `performance.timeOrigin` differ by a fraction of a millisecond. */
const CLOCK_SKEW_MS = 2;

const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: pg is untyped here on purpose (structural use only)
const pg = require("pg") as any;

const reason = skipReason("postgres");
const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
  new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  }),
);
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
const host = hostMeterProvider();
metrics.setGlobalMeterProvider(host.provider);

const POOL = Symbol("POOL");

@Controller("tx")
class TxController {
  // biome-ignore lint/suspicious/noExplicitAny: pg pool, structural use only
  constructor(@Inject(POOL) private readonly pool: any) {}

  @Get(":id")
  async run(@Param("id") id: string): Promise<{ id: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.request', $1, true)", [id]);
      await client.query("SELECT pg_sleep(0.03)");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    return { id };
  }
}

// biome-ignore lint/suspicious/noExplicitAny: see above
function appModule(pool: any) {
  @Module({
    imports: [NestrixModule.forRoot({ ui: false })],
    controllers: [TxController],
    providers: [{ provide: POOL, useValue: pool }],
  })
  class PoolAppModule {}
  return PoolAppModule;
}

function poolConfig() {
  const a = address("postgres");
  return {
    host: a.host,
    port: a.port,
    user: "postgres",
    database: "nestrix",
    max: 2,
  };
}

async function waitCount(
  name: string,
): Promise<{ count: number; sum: number }> {
  const rm = await collect(host.reader);
  const found = points(rm, "db.client.connection.wait_time").filter(
    (p) => p.attributes["db.client.connection.pool.name"] === name,
  );
  return {
    count: found.reduce((n, p) => n + (p.value as Histogram).count, 0),
    sum: found.reduce((n, p) => n + ((p.value as Histogram).sum ?? 0), 0),
  };
}

const ADAPTERS = ["express", "fastify", "node"] as const;

describe.skipIf(reason !== undefined)("pool wait in a Nest app", () => {
  beforeAll(async () => {
    await waitUntil(
      async () => {
        const c = new pg.Client(poolConfig());
        await c.connect();
        await c.end();
      },
      30_000,
      "postgres",
    );
  }, 40_000);

  afterEach(() => exporter.reset());

  it.each(ADAPTERS)(
    "%s: pool of 2, 10 concurrent requests: waits in the metric and in each request's trace",
    async (adapter) => {
      const pool = new pg.Pool(poolConfig());
      const name = `${poolConfig().host}:${poolConfig().port}/nestrix`;
      const { app, baseUrl } = await bootOwned(adapter, appModule(pool));
      try {
        // Open both connections first, so every wait below is a wait for a free client.
        await Promise.all([
          fetch(`${baseUrl}/tx/w1`),
          fetch(`${baseUrl}/tx/w2`),
        ]);
        exporter.reset();
        const before = await waitCount(name);

        const responses = await Promise.all(
          Array.from({ length: 10 }, (_, i) => fetch(`${baseUrl}/tx/${i}`)),
        );
        expect(responses.map((r) => r.status)).toEqual(Array(10).fill(200));
        await Promise.all(responses.map((r) => r.json()));

        const after = await waitCount(name);
        expect(after.count - before.count).toBe(10);
        // 10 requests, 2 clients, 30+ ms each: the queued ones waited at least 8 x 30 ms in total.
        expect(after.sum - before.sum).toBeGreaterThanOrEqual(8 * 0.025);

        await waitUntil(
          async () => {
            const servers = exporter
              .getFinishedSpans()
              .filter((s) => s.kind === SpanKind.SERVER);
            if (servers.length < 10)
              throw new Error(`${servers.length} server spans`);
          },
          5_000,
          "server spans",
        );
        const finished = exporter.getFinishedSpans();
        const servers = finished.filter((s) => s.kind === SpanKind.SERVER);
        const connects = finished.filter(
          (s) => s.name === PG_POOL_CONNECT_SPAN,
        );
        // Two requests found a free client (no span); eight queued (a span each).
        expect(connects.length).toBeGreaterThanOrEqual(7);
        expect(connects.length).toBeLessThanOrEqual(8);
        const byTrace = new Map<string, ReadableSpan[]>();
        for (const s of connects) {
          const list = byTrace.get(s.spanContext().traceId) ?? [];
          list.push(s);
          byTrace.set(s.spanContext().traceId, list);
        }
        const serverTraces = new Set(
          servers.map((s) => s.spanContext().traceId),
        );
        for (const [traceId, list] of byTrace) {
          expect(serverTraces.has(traceId)).toBe(true);
          expect(list).toHaveLength(1);
          // Under the request (its controller method span or the server span), not another's.
          const parent = finished.find(
            (s) => s.spanContext().spanId === parentId(list[0] as ReadableSpan),
          );
          expect(parent?.spanContext().traceId).toBe(traceId);
          // D-59: the request's BEGIN span starts after its wait ended.
          const connect = list[0] as ReadableSpan;
          const begin = dbSpans(finished).find(
            (s) => s.name === "BEGIN" && s.spanContext().traceId === traceId,
          );
          expect(begin).toBeDefined();
          if (begin !== undefined)
            expect(startMs(begin)).toBeGreaterThanOrEqual(
              startMs(connect) + durationMs(connect) - CLOCK_SKEW_MS,
            );
          expect(list[0]?.attributes["db.client.connection.pool.name"]).toBe(
            name,
          );
        }
      } finally {
        await app.close();
        await pool.end();
      }
    },
    30_000,
  );
});
