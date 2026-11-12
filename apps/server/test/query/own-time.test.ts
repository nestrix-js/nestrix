/**
 * Own time (a span's duration minus its children's) in `GET /api/v1/overview` and
 * `GET /api/v1/classes`, against PostgreSQL.
 *
 * Regression: the children used to be summed with a correlated subquery per span and no index
 * on the parent, so a trace of thousands of spans (a job joining the request's trace) made both
 * endpoints take seconds. The large-trace test fixes the shape of the real report: an HTTP root
 * -> a BullMQ producer -> a consumer job in another service -> per row a method span with ten
 * database spans under it.
 */
import "reflect-metadata";
import type {
  ClassStatsResponse,
  OverviewResponse,
} from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresIngestSink } from "../../src/storage/writer.js";
import {
  batch,
  createTestDb,
  noDatabase,
  skipReason,
  span,
  type TestDb,
} from "../storage/helpers.js";
import { type QueryServer, startQueryServer } from "./helpers.js";

const tid = (n: number) => n.toString(16).padStart(32, "0");
const sid = (n: number) => n.toString(16).padStart(16, "0");
const MIN = 60_000;
const NOW = Date.now();
const PG = { "db.system.name": "postgresql", "server.address": "db.local" };
const ROWS = Number(process.env.OWN_TIME_ROWS ?? 520);
const DB_PER_ROW = 9;
/** Generous: the old query took 4 to 8 s on the same shape. */
const LIMIT_MS = Number(process.env.OWN_TIME_LIMIT_MS ?? 1500);

async function timed<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  const ms = performance.now() - t0;
  console.log(`own-time: ${label} took ${ms.toFixed(0)} ms`);
  return { value, ms };
}

describe.skipIf(noDatabase)(`own time ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;
  let total = 0;

  beforeAll(async () => {
    db = await createTestDb("owntime");
    server = await startQueryServer(db.url);
    const sink = server.app.get(PostgresIngestSink);
    const base = NOW - 6 * MIN;

    // The big trace. Ids: 1 root, 2 producer, 3 consumer job, then per row 10 + 100 * row ...
    const big = tid(1);
    const shop = [
      span({
        traceId: big,
        spanId: sid(1),
        name: "POST /upload",
        kind: "server",
        startMs: base,
        durationMs: 125,
        attributes: {
          "http.request.method": "POST",
          "http.route": "/upload",
          "http.response.status_code": 202,
        },
      }),
      span({
        traceId: big,
        spanId: sid(2),
        parentSpanId: sid(1),
        name: "import send",
        kind: "producer",
        startMs: base + 100,
        durationMs: 5,
        attributes: { "messaging.system": "bullmq" },
      }),
    ];
    const worker = [
      span({
        traceId: big,
        spanId: sid(3),
        parentSpanId: sid(2),
        name: "import process",
        kind: "consumer",
        startMs: base + 110,
        durationMs: 20_000,
        attributes: { "messaging.system": "bullmq" },
      }),
    ];
    for (let r = 0; r < ROWS; r++) {
      const rowId = 1000 + r * 100;
      const start = base + 120 + r * 5;
      worker.push(
        span({
          traceId: big,
          spanId: sid(rowId),
          parentSpanId: sid(3),
          name: "ImportProcessor.row",
          kind: "internal",
          startMs: start,
          durationMs: 4,
          attributes: {
            "nestrix.class": "ImportProcessor",
            "nestrix.method": "row",
          },
        }),
      );
      for (let d = 1; d <= DB_PER_ROW; d++) {
        worker.push(
          span({
            traceId: big,
            spanId: sid(rowId + d),
            parentSpanId: sid(rowId),
            name: "pg.query",
            kind: "client",
            startMs: start + d * 0.1,
            durationMs: 0.4,
            attributes: PG,
          }),
        );
      }
    }
    total = shop.length + worker.length;

    // Ordinary traffic next to it.
    const ordinary = [];
    for (let i = 0; i < 25; i++) {
      ordinary.push(
        span({
          traceId: tid(100 + i),
          spanId: sid(100 + i),
          name: "GET /orders",
          kind: "server",
          startMs: base + 1000 + i * 1000,
          durationMs: 30,
          attributes: {
            "http.request.method": "GET",
            "http.route": "/orders",
            "http.response.status_code": 200,
          },
        }),
      );
    }
    await sink.write(batch("shop", [...shop, ...ordinary]));
    // The worker is another service; written in slices so one batch stays reasonable.
    for (let i = 0; i < worker.length; i += 2000) {
      await sink.write(batch("worker", worker.slice(i, i + 2000)));
    }
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  it("answers overview (both windows) and classes on a trace of thousands of spans, quickly", async () => {
    const count = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM spans WHERE trace_id = $1",
      [tid(1)],
    );
    expect(count.rows[0]?.n).toBe(total);
    console.log(`own-time: fixture trace has ${total} spans`);

    const overview = await timed("overview", () =>
      server.json<OverviewResponse>("/api/v1/overview"),
    );
    expect(overview.ms).toBeLessThan(LIMIT_MS);
    const dbMs = overview.value.timeByKind.find((k) => k.key === "db")?.ms;
    expect(dbMs).toBeCloseTo(ROWS * DB_PER_ROW * 0.4, 0);
    expect(overview.value.totals.count).toBe(26);

    const classes = await timed("classes", () =>
      server.json<ClassStatsResponse>("/api/v1/classes"),
    );
    expect(classes.ms).toBeLessThan(LIMIT_MS);
    const importer = classes.value.classes.find(
      (c) => c.className === "ImportProcessor",
    );
    expect(importer?.calls).toBe(ROWS);
    // 4 ms minus nine 0.4 ms database spans.
    expect(importer?.methods[0]?.ownAvgMs).toBeCloseTo(0.4, 1);
  }, 60_000);

  it("subtracts a child that starts before its parent (a slow clock on another host)", async () => {
    const t = tid(900);
    const start = NOW - 4 * MIN;
    const sink = server.app.get(PostgresIngestSink);
    await sink.write(
      batch("skew-shop", [
        span({
          traceId: t,
          spanId: sid(901),
          name: "GET /skew",
          kind: "server",
          startMs: start,
          durationMs: 80,
          attributes: {
            "http.request.method": "GET",
            "http.route": "/skew",
            "http.response.status_code": 200,
          },
        }),
        span({
          traceId: t,
          spanId: sid(902),
          parentSpanId: sid(901),
          name: "SkewService.find",
          kind: "internal",
          startMs: start + 1,
          durationMs: 70,
          attributes: {
            "nestrix.class": "SkewService",
            "nestrix.method": "find",
          },
        }),
      ]),
    );
    await sink.write(
      batch("skew-remote", [
        // Starts 5 ms before its parent on this host's clock.
        span({
          traceId: t,
          spanId: sid(903),
          parentSpanId: sid(902),
          name: "remote call",
          kind: "client",
          startMs: start + 1 - 5,
          durationMs: 30,
          attributes: PG,
        }),
      ]),
    );
    const r = await server.json<ClassStatsResponse>(
      "/api/v1/classes?service=skew-shop",
    );
    // 70 ms minus the 30 ms child, although the child began first.
    expect(r.classes[0]?.methods[0]?.ownAvgMs).toBeCloseTo(40, 3);
  });
});
