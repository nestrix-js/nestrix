/**
 * The per-trace span cap (D-78): spans of a trace past `NESTRIX_MAX_SPANS_PER_TRACE` are not
 * stored, counted in `traces.dropped_spans` and reported per batch; the `trace` query merges that
 * count with the app's `nestrix.trace.spans_dropped*` attributes.
 */
import "reflect-metadata";
import type { TraceResponse } from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PartitionManager } from "../../src/storage/partitions.js";
import { STORAGE_PARTITIONS } from "../../src/storage/storage.module.js";
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
const T0 = Date.now() - 120_000;

/** `count` spans of one trace: span 1 is the root, the others its children, one ms apart. */
function spansOf(traceId: string, count: number, attributes = {}) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    out.push(
      span({
        traceId,
        spanId: i.toString(16).padStart(16, "0"),
        ...(i > 1 ? { parentSpanId: "0000000000000001" } : {}),
        name: i === 1 ? "GET /big" : "child",
        kind: i === 1 ? "server" : "internal",
        startMs: T0 + i,
        durationMs: 1,
        attributes: i === 1 ? attributes : {},
      }),
    );
  }
  return out;
}

describe.skipIf(noDatabase)(`per-trace span cap ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;
  let partitions: PartitionManager;

  beforeAll(async () => {
    db = await createTestDb("tracecap");
    // The whole server with the default cap (50,000); the small-cap sinks below share its database.
    server = await startQueryServer(db.url);
    partitions = server.app.get<PartitionManager>(STORAGE_PARTITIONS);
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  const storedCount = async (traceId: string) =>
    Number(
      (
        await db.pool.query<{ n: string }>(
          "SELECT count(*) AS n FROM spans WHERE trace_id = $1",
          [traceId],
        )
      ).rows[0]?.n,
    );

  it("stores 50,000 of 60,000 spans of one trace and counts 10,000 as dropped by the server", async () => {
    const sink = server.app.get(PostgresIngestSink);
    const id = tid(1);
    const other = tid(2);
    const result = await sink.write(
      batch("shop", [...spansOf(id, 60_000), ...spansOf(other, 3)]),
    );
    expect(result).toEqual({ droppedSpans: 10_000 });
    expect(await storedCount(id)).toBe(50_000);
    expect(await storedCount(other)).toBe(3);
    // The earliest spans are the ones kept, so the root is stored.
    const root = await db.pool.query(
      "SELECT 1 FROM spans WHERE trace_id = $1 AND span_id = '0000000000000001'",
      [id],
    );
    expect(root.rowCount).toBe(1);
    const row = (
      await db.pool.query(
        "SELECT span_count, dropped_spans FROM traces WHERE trace_id = $1",
        [id],
      )
    ).rows[0];
    expect(row.span_count).toBe(50_000);
    expect(row.dropped_spans).toBe("10000");

    // A later batch of the full trace: nothing fits, everything is dropped and counted.
    const later = await sink.write(
      batch(
        "shop",
        spansOf(tid(1), 5).map((s, i) => ({
          ...s,
          spanId: (70_000 + i).toString(16).padStart(16, "0"),
        })),
      ),
    );
    expect(later).toEqual({ droppedSpans: 5 });
    expect(await storedCount(id)).toBe(50_000);

    const t = await server.json<TraceResponse>(`/api/v1/trace?id=${id}`);
    expect(t.spans).toHaveLength(50_000);
    expect(t.droppedSpans).toEqual({
      total: 10_005,
      byKind: {},
      byServer: 10_005,
    });
    const untouched = await server.json<TraceResponse>(
      `/api/v1/trace?id=${other}`,
    );
    expect(untouched.droppedSpans).toBeUndefined();
  }, 60_000);

  describe("with a small cap", () => {
    let sink: PostgresIngestSink;
    beforeAll(() => {
      sink = new PostgresIngestSink(db.pool, partitions, {
        maxSpansPerTrace: 1_000,
      });
    });

    it("keeps the cap across batches and reports the drop per batch of a group commit", async () => {
      const id = tid(10);
      const spans = spansOf(id, 1_500);
      // Three batches written together (one transaction): 600 + 600 + 300 spans.
      const results = await Promise.all([
        sink.write(batch("shop", spans.slice(0, 600))),
        sink.write(batch("shop", spans.slice(600, 1_200))),
        sink.write(batch("shop", spans.slice(1_200))),
      ]);
      const dropped = results.map((r) => r?.droppedSpans ?? 0);
      expect(dropped.reduce((a, b) => a + b, 0)).toBe(500);
      expect(await storedCount(id)).toBe(1_000);
      const row = (
        await db.pool.query(
          "SELECT dropped_spans FROM traces WHERE trace_id = $1",
          [id],
        )
      ).rows[0];
      expect(row.dropped_spans).toBe("500");
    });

    it("does not let one trace's cap affect another trace in the same batch", async () => {
      const big = tid(11);
      const small = tid(12);
      const result = await sink.write(
        batch("shop", [...spansOf(big, 1_100), ...spansOf(small, 900)]),
      );
      expect(result).toEqual({ droppedSpans: 100 });
      expect(await storedCount(big)).toBe(1_000);
      expect(await storedCount(small)).toBe(900);
    });

    it("sums the app's attributes by kind over every service and adds the server's count", async () => {
      const id = tid(13);
      await sink.write(
        batch(
          "shop",
          spansOf(id, 600, {
            "nestrix.trace.spans_dropped": 700,
            "nestrix.trace.spans_dropped.db": 500,
            "nestrix.trace.spans_dropped.redis": 200,
          }),
        ),
      );
      // A second service reports its own drops on its own span of the same trace.
      await sink.write(
        batch("worker", [
          span({
            traceId: id,
            spanId: "00000000000fffff",
            parentSpanId: "0000000000000001",
            name: "q process",
            kind: "consumer",
            startMs: T0 + 5,
            durationMs: 1,
            attributes: {
              "nestrix.trace.spans_dropped": 30,
              "nestrix.trace.spans_dropped.db": 10,
              "nestrix.trace.spans_dropped.messaging": 20,
            },
          }),
        ]),
      );
      // 601 stored; 600 more arrive: 399 fit, 201 are dropped by the server.
      const more = spansOf(id, 600).map((s, i) => ({
        ...s,
        spanId: (0x100000 + i).toString(16).padStart(16, "0"),
        parentSpanId: "0000000000000001",
      }));
      const result = await sink.write(batch("shop", more));
      expect(result).toEqual({ droppedSpans: 201 });
      const t = await server.json<TraceResponse>(`/api/v1/trace?id=${id}`);
      expect(t.droppedSpans).toEqual({
        total: 730 + 201,
        byKind: { db: 510, redis: 200, messaging: 20 },
        byServer: 201,
      });
    });
  });
});
