/**
 * P9-07 standalone, end to end against PostgreSQL: OTLP log records posted to `/v1/logs` (through
 * the real receiver and writer) are stored in the day-partitioned `logs` table, capped per trace
 * (also under concurrent exports), deduplicated on retry, and served with the trace by
 * `GET /api/v1/trace/logs?id=` behind the admin session.
 */
import "reflect-metadata";
import type { TraceLogsResponse } from "@nestrix-js/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  IngestLogBatch,
  IngestLogRecord,
} from "../../src/ingest/model.js";
import { MAX_LOGS_PER_TRACE } from "../../src/storage/logs.js";
import { listPartitions } from "../../src/storage/partitions.js";
import { PostgresIngestSink } from "../../src/storage/writer.js";
import { auth, JSON_TYPE, post } from "../ingest/helpers.js";
import {
  createTestDb,
  hex,
  noDatabase,
  nsAt,
  skipReason,
  type TestDb,
} from "../storage/helpers.js";
import { type QueryServer, startQueryServer } from "./helpers.js";

function logBatch(
  records: IngestLogRecord[],
  service = "shop",
): IngestLogBatch {
  return {
    resourceLogs: [{ resource: { "service.name": service }, records }],
    rejectedLogRecords: 0,
  };
}

function line(
  traceId: string,
  i: number,
  over: Partial<IngestLogRecord> = {},
): IngestLogRecord {
  return {
    traceId,
    spanId: "00000000000000a1",
    timeUnixNano: nsAt(Date.now() - 10_000) + BigInt(i),
    severityNumber: 9,
    severityText: "log",
    body: `line ${i}`,
    context: "Svc",
    ...over,
  };
}

describe.skipIf(noDatabase)(`trace logs ${skipReason}`, () => {
  let db: TestDb;
  let server: QueryServer;
  let sink: PostgresIngestSink;

  beforeAll(async () => {
    db = await createTestDb("tracelogs");
    server = await startQueryServer(db.url);
    sink = server.app.get(PostgresIngestSink);
  });
  afterAll(async () => {
    await server?.close();
    await db?.drop();
  });

  const logsOf = (id: string) =>
    server.json<TraceLogsResponse>(`/api/v1/trace/logs?id=${id}`);

  it("POST /v1/logs → stored → served with the trace, oldest first", async () => {
    const traceId = hex(16);
    const t = Date.now() - 5_000;
    const body = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "api" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: String(nsAt(t + 2)),
                  severityNumber: 13,
                  severityText: "WARN",
                  body: { stringValue: "second" },
                  traceId,
                  spanId: "00000000000000b2",
                },
                {
                  timeUnixNano: String(nsAt(t + 1)),
                  severityNumber: 9,
                  severityText: "INFO",
                  body: { stringValue: "first" },
                  traceId,
                  attributes: [
                    {
                      key: "nestrix.log.context",
                      value: { stringValue: "Users" },
                    },
                  ],
                },
                {
                  timeUnixNano: String(nsAt(t)),
                  body: { stringValue: "no trace" },
                },
              ],
            },
          ],
        },
      ],
    };
    const res = await post(`${server.baseUrl}/v1/logs`, JSON.stringify(body), {
      ...auth(),
      "content-type": JSON_TYPE,
    });
    expect(res.status).toBe(200);
    const logs = await logsOf(traceId);
    expect(logs).toEqual({
      traceId,
      truncated: false,
      items: [
        {
          timeUnixMs: t + 1,
          severity: 9,
          level: "INFO",
          context: "Users",
          message: "first",
          service: "api",
        },
        {
          timeUnixMs: t + 2,
          severity: 13,
          level: "WARN",
          message: "second",
          spanId: "00000000000000b2",
          service: "api",
        },
      ],
    });
    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM logs");
    expect(rows[0].n).toBe(2);
  });

  it(`caps a trace at ${MAX_LOGS_PER_TRACE} lines across batches and concurrent exports`, async () => {
    const traceId = hex(16);
    await sink.writeLogs(
      logBatch(Array.from({ length: 150 }, (_, i) => line(traceId, i))),
    );
    // Eight concurrent batches of 30 more each: only 50 fit.
    await Promise.all(
      Array.from({ length: 8 }, (_, b) =>
        sink.writeLogs(
          logBatch(
            Array.from({ length: 30 }, (_, i) =>
              line(traceId, 1000 + b * 100 + i),
            ),
          ),
        ),
      ),
    );
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM logs WHERE trace_id = $1",
      [traceId],
    );
    expect(rows[0].n).toBe(MAX_LOGS_PER_TRACE);
    const served = await logsOf(traceId);
    expect(served.items).toHaveLength(MAX_LOGS_PER_TRACE);
    expect(served.truncated).toBe(true);
    expect(sink.logs.stats().droppedOverCap).toBe(
      150 + 240 - MAX_LOGS_PER_TRACE,
    );
  });

  it("a retried export stores nothing twice; a line outside retention is dropped", async () => {
    const traceId = hex(16);
    const records = [line(traceId, 1), line(traceId, 2)];
    await sink.writeLogs(logBatch(records));
    await sink.writeLogs(logBatch(records));
    const old = line(traceId, 3, {
      timeUnixNano: nsAt(Date.now() - 30 * 86_400_000),
    });
    const before = sink.logs.stats().outOfRange;
    await sink.writeLogs(logBatch([old]));
    expect(sink.logs.stats().outOfRange).toBe(before + 1);
    expect((await logsOf(traceId)).items.map((l) => l.message)).toEqual([
      "line 1",
      "line 2",
    ]);
  });

  it("the logs table is day-partitioned like spans", async () => {
    const parts = await listPartitions(db.pool);
    expect([...(parts.get("logs") ?? [])].sort()).toEqual(
      [...(parts.get("spans") ?? [])].sort(),
    );
    expect(parts.get("logs")?.size).toBeGreaterThanOrEqual(3);
  });

  it("an unknown trace answers no items; a bad id is 400; signed out is refused", async () => {
    expect(await logsOf("a".repeat(32))).toEqual({
      traceId: "a".repeat(32),
      items: [],
      truncated: false,
    });
    for (const q of [
      "",
      "?id=nope",
      "?id=A".padEnd(36, "A"),
      `?id=${"a".repeat(32)}&x=1`,
    ]) {
      const res = await server.get(`/api/v1/trace/logs${q}`);
      expect(res.status, q).toBe(400);
    }
    const anonymous = await fetch(
      `${server.baseUrl}/api/v1/trace/logs?id=${"a".repeat(32)}`,
    );
    expect(anonymous.status).toBe(401);
    expect(
      [...anonymous.headers.keys()].filter((k) =>
        k.startsWith("access-control-"),
      ),
    ).toEqual([]);
  });
});
