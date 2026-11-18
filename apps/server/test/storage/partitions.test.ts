import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IngestLogRecord } from "../../src/ingest/model.js";
import { runMigrations } from "../../src/storage/migrate.js";
import {
  dayLabel,
  dropExpiredPartitions,
  ensurePartitions,
  listPartitions,
  PARTITIONED_TABLES,
  PartitionManager,
  utcDay,
} from "../../src/storage/partitions.js";
import { PostgresIngestSink } from "../../src/storage/writer.js";
import {
  batch,
  createTestDb,
  hex,
  noDatabase,
  nsAt,
  skipReason,
  span,
  type TestDb,
} from "./helpers.js";

const DAY = 86_400_000;

describe.skipIf(noDatabase)(`partitions and retention ${skipReason}`, () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb("partitions");
    await runMigrations(db.pool);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("start creates today and the next two days for every table", async () => {
    const now = Date.UTC(2026, 10, 11, 23, 59, 0);
    const manager = new PartitionManager(db.pool, {
      retentionDays: 7,
      now: () => now,
    });
    await manager.start();
    manager.stop();
    const parts = await listPartitions(db.pool);
    const today = utcDay(now);
    for (const table of PARTITIONED_TABLES) {
      expect([...(parts.get(table) ?? [])].sort(), table).toEqual([
        today,
        today + 1,
        today + 2,
      ]);
    }
    expect(dayLabel(today)).toBe("20261111");
    expect(manager.hasDay(today + 2)).toBe(true);
    expect(manager.hasDay(today + 3)).toBe(false);
    // Bounds are UTC days.
    const { rows } = await db.pool.query(
      "SELECT pg_get_expr(c.relpartbound, c.oid) AS bound FROM pg_class c WHERE relname = 'spans_p20261111'",
    );
    expect(rows[0].bound).toBe(
      "FOR VALUES FROM ('2026-11-11 00:00:00+00') TO ('2026-11-12 00:00:00+00')",
    );
    // Idempotent.
    expect(await ensurePartitions(db.pool, [today, today + 1])).toEqual([]);
  });

  it("retention drops partitions (and their rows) older than the retention, keeps the rest", async () => {
    const now = Date.UTC(2026, 10, 20, 12, 0, 0);
    const today = utcDay(now);
    // An old day (10 days back), the oldest kept day (7 back) and the first dropped day (8 back).
    const oldDays = [today - 10, today - 8, today - 7];
    await ensurePartitions(db.pool, oldDays);
    // Insert through the writer: its clock says it is still the old day, so the rows are in range.
    for (const day of oldDays) {
      const then = day * DAY + 3_600_000;
      const manager = new PartitionManager(db.pool, {
        retentionDays: 7,
        now: () => then,
      });
      await manager.start();
      manager.stop();
      const sink = new PostgresIngestSink(db.pool, manager);
      const traceId = hex(16);
      await sink.write(
        batch("old-service", [
          span({
            traceId,
            kind: "server",
            startMs: then,
            durationMs: 5,
            attributes: { "http.request.method": "GET", "http.route": "/old" },
          }),
        ]),
      );
    }
    const count = async (table: string, day: number) =>
      (
        await db.pool.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${table === "traces" ? "partition_time" : table.endsWith("minutes") ? "minute" : "start_time"} >= $1 AND ${table === "traces" ? "partition_time" : table.endsWith("minutes") ? "minute" : "start_time"} < $2`,
          [new Date(day * DAY), new Date((day + 1) * DAY)],
        )
      ).rows[0].n as number;
    for (const day of oldDays) {
      expect(await count("spans", day)).toBe(1);
      expect(await count("traces", day)).toBe(1);
      expect(await count("route_minutes", day)).toBe(1);
    }

    const before = await listPartitions(db.pool);
    const dropped = await dropExpiredPartitions(db.pool, 7, now);
    // Every partition of a day before today - 7 (the old-clock managers also made their own
    // "today + 2" partitions), and nothing else.
    const expired = PARTITIONED_TABLES.flatMap((t) =>
      [...(before.get(t) ?? [])]
        .filter((d) => d < today - 7)
        .map((d) => `${t}_p${dayLabel(d)}`),
    );
    expect(expired).toContain(`spans_p${dayLabel(today - 10)}`);
    expect(expired).toContain(`traces_p${dayLabel(today - 8)}`);
    expect(dropped.sort()).toEqual(expired.sort());
    const parts = await listPartitions(db.pool);
    for (const table of PARTITIONED_TABLES) {
      const days = parts.get(table) ?? new Set();
      expect(days.has(today - 10)).toBe(false);
      expect(days.has(today - 8)).toBe(false);
      expect(days.has(today - 7)).toBe(true);
    }
    expect(await count("spans", today - 10)).toBe(0);
    expect(await count("spans", today - 8)).toBe(0);
    expect(await count("spans", today - 7)).toBe(1);
    expect(await count("traces", today - 7)).toBe(1);
  });

  it("the manager's run drops expired days and the writer refuses spans outside the kept range", async () => {
    const now = Date.UTC(2026, 10, 30, 12, 0, 0);
    const manager = new PartitionManager(db.pool, {
      retentionDays: 3,
      now: () => now,
    });
    await manager.start();
    manager.stop();
    const parts = await listPartitions(db.pool);
    const today = utcDay(now);
    for (const day of parts.get("spans") ?? []) {
      expect(day).toBeGreaterThanOrEqual(today - 3);
    }
    const sink = new PostgresIngestSink(db.pool, manager);
    const traceId = hex(16);
    await sink.write(
      batch("svc", [
        span({ traceId, startMs: now - 5 * DAY, durationMs: 1 }), // too old
        span({ traceId, startMs: now + 4 * DAY, durationMs: 1 }), // too far ahead
        span({ traceId, startMs: now - 2 * DAY, durationMs: 1 }), // kept day without partition: created
      ]),
    );
    expect(sink.stats()).toMatchObject({ writtenSpans: 1, outOfRangeSpans: 2 });
    expect(manager.hasDay(today - 2)).toBe(true);
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM spans WHERE trace_id = $1",
      [traceId],
    );
    expect(rows[0].n).toBe(1);
  });
  it("log retention drops the logs partitions and drop counters early, spans keep their days", async () => {
    // Far from the other tests' days: their partitions are expired by this run anyway.
    const now = Date.UTC(2027, 2, 10, 12, 0, 0);
    const today = utcDay(now);
    await ensurePartitions(db.pool, [today - 5, today - 1]);
    const dayText = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
    await db.pool.query(
      "INSERT INTO log_drops (day, reason, dropped) VALUES ($1, 'rate_cap', 4), ($2, 'rate_cap', 6) ON CONFLICT (day, reason) DO UPDATE SET dropped = EXCLUDED.dropped",
      [dayText(today - 5), dayText(today - 1)],
    );
    const dropped = await dropExpiredPartitions(db.pool, 7, now, 2);
    expect(dropped).toContain(`logs_p${dayLabel(today - 5)}`);
    expect(dropped).not.toContain(`logs_p${dayLabel(today - 1)}`);
    expect(dropped.filter((n) => n.startsWith("spans_p"))).not.toContain(
      `spans_p${dayLabel(today - 5)}`,
    );
    const parts = await listPartitions(db.pool);
    expect(parts.get("logs")?.has(today - 5)).toBe(false);
    expect(parts.get("logs")?.has(today - 1)).toBe(true);
    expect(parts.get("spans")?.has(today - 5)).toBe(true);
    expect(parts.get("traces")?.has(today - 5)).toBe(true);
    const { rows } = await db.pool.query(
      "SELECT day::text AS day FROM log_drops WHERE day IN ($1, $2) ORDER BY day",
      [dayText(today - 5), dayText(today - 1)],
    );
    expect(rows.map((r) => r.day)).toEqual([dayText(today - 1)]);
  });

  it("a day without a logs partition still takes spans, and its log lines count as out of range", async () => {
    const now = Date.UTC(2027, 5, 10, 12, 0, 0);
    const today = utcDay(now);
    const manager = new PartitionManager(db.pool, {
      retentionDays: 7,
      logRetentionDays: 2,
      now: () => now,
    });
    // today - 5 exists for spans and traces but, by the log retention, never for logs.
    await ensurePartitions(db.pool, [today - 5]);
    await manager.start();
    manager.stop();
    const parts = await listPartitions(db.pool);
    expect(parts.get("logs")?.has(today - 5)).toBe(false);
    expect(parts.get("spans")?.has(today - 5)).toBe(true);
    // refresh() counts the day as available because only `logs` lacks it, by design.
    expect(manager.hasDay(today - 5)).toBe(true);
    expect(manager.acceptedLogDays().first).toBe(today - 2);

    const sink = new PostgresIngestSink(db.pool, manager);
    const traceId = hex(16);
    const then = (today - 5) * DAY + 3_600_000;
    await sink.write(
      batch("svc", [span({ traceId, startMs: then, durationMs: 1 })]),
    );
    expect(sink.stats()).toMatchObject({ writtenSpans: 1, outOfRangeSpans: 0 });
    const log = (day: number): IngestLogRecord => ({
      traceId,
      timeUnixNano: nsAt(day * DAY + 3_600_000),
      severityNumber: 9,
      severityText: "INFO",
      body: "x",
    });
    await sink.writeLogs({
      resourceLogs: [
        {
          resource: { "service.name": "svc" },
          records: [log(today - 5), log(today)],
        },
      ],
      rejectedLogRecords: 0,
    });
    expect(sink.logs.stats()).toMatchObject({
      writtenLogs: 1,
      outOfRange: 1,
    });
  });
});
