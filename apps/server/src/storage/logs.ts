/**
 * Stores OTLP log records (P9-07): the `logs` table (migrations/0007_logs.sql, 0021).
 *
 * By default context for a trace (D-19 as amended, D-75). With `mode: "all"` (`NESTRIX_LOGS=all`,
 * issue #17, D-106) records without a trace id are stored too (trace id `''`), the per-trace cap is
 * `allMaxPerTrace` and at most `maxPerMinute` lines are stored per minute by this process. Every
 * dropped line is counted per UTC day and reason in `log_drops` (shown by `GET api/v1/logs`).
 * Bounds:
 *
 * - per trace: at most `maxPerTrace` (200) lines are ever stored; later ones are dropped and counted
 *   (`droppedOverCap`). The count is read and the rows inserted in one transaction under a per-trace
 *   advisory lock (`LOGS_LOCK_CLASS`, taken in trace id order), so concurrent exports, and several
 *   server instances, cannot pass the cap;
 * - days: a record older than retention, or more than two days ahead, is dropped (`outOfRange`), as
 *   spans are; a missing day partition within retention is created; the partitions are dropped by
 *   the same retention as spans;
 * - in flight: at most `maxInflightRecords` records are being written at once; a batch beyond it is
 *   refused with `IngestBusyError` (the receiver answers 503 with `Retry-After`).
 *
 * A retried export does not store a line twice: the primary key holds a hash of the stored fields.
 * Transient database failures reject with `IngestBusyError`, like the span writer.
 */
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  IngestBusyError,
  type IngestLogBatch,
  type IngestLogRecord,
} from "../ingest/model.js";
import { deriveResource, MAX_NS, nsToIso } from "./derive.js";
import { LOGS_LOCK_CLASS } from "./locks.js";
import { type PartitionManager, utcDay } from "./partitions.js";
import { isTransient } from "./writer.js";

/** Lines kept per trace (the embedded store's `MAX_LOGS_PER_TRACE`). */
export const MAX_LOGS_PER_TRACE = 200;

export interface LogWriterOptions {
  /** Records being written at once before `write` answers busy. Default 20 000. */
  maxInflightRecords?: number;
  /** Lines kept per trace in `trace` mode. Default 200. */
  maxPerTrace?: number;
  /** `trace` (default): only records with a trace id. `all`: also records without one. */
  mode?: "trace" | "all";
  /** Lines kept per trace in `all` mode. Default 1000. */
  allMaxPerTrace?: number;
  /** Lines stored per clock minute in `all` mode; the rest is counted as dropped. Default 30 000. */
  maxPerMinute?: number;
  /** Clock, for tests. */
  now?: () => number;
  /** `Retry-After` given with `IngestBusyError`. Default 5. */
  retryAfterSeconds?: number;
}

export interface LogWriterStats {
  inflightRecords: number;
  writtenLogs: number;
  duplicateLogs: number;
  /** Lines not stored because their trace already held `maxPerTrace`. */
  droppedOverCap: number;
  /** Lines outside the stored days. */
  outOfRange: number;
  /** Lines not stored because this minute's `maxPerMinute` was reached (`all` mode). */
  droppedRateCap: number;
  busyRejections: number;
}

interface LogRow {
  traceId: string;
  spanId: string | null;
  time: string;
  timeNs: bigint;
  day: number;
  severityNumber: number;
  severityText: string;
  body: string;
  context: string | null;
  serviceName: string;
  truncated: boolean;
  /** The resource's environment (D-101); `null` is unset. Not part of `hash`. */
  environment: string | null;
  hash: string;
}

/** Why a line was not stored; the keys of `log_drops.reason`. */
export type LogDropReason = "trace_cap" | "rate_cap" | "out_of_range";

function rowOf(
  record: IngestLogRecord,
  serviceName: string,
  environment: string | null,
): LogRow | null {
  const ns = record.timeUnixNano;
  if (ns <= 0n || ns > MAX_NS) return null;
  const spanId = record.spanId ?? null;
  const context = record.context ?? null;
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        record.traceId,
        spanId,
        ns.toString(),
        record.severityNumber,
        record.severityText,
        record.body,
        context,
        serviceName,
      ]),
    )
    .digest("hex");
  return {
    traceId: record.traceId,
    spanId,
    time: nsToIso(ns),
    timeNs: ns,
    day: utcDay(Number(ns / 1_000_000n)),
    severityNumber: record.severityNumber,
    severityText: record.severityText,
    body: record.body,
    context,
    serviceName,
    truncated: record.truncated === true,
    environment,
    hash,
  };
}

export class PostgresLogWriter {
  private readonly maxInflight: number;
  private readonly maxPerTrace: number;
  private readonly retryAfterSeconds: number;
  private readonly all: boolean;
  private readonly maxPerMinute: number;
  private readonly now: () => number;
  private minute = -1;
  private minuteCount = 0;
  private inflight = 0;
  private closed = false;
  private readonly counters = {
    writtenLogs: 0,
    duplicateLogs: 0,
    droppedOverCap: 0,
    outOfRange: 0,
    droppedRateCap: 0,
    busyRejections: 0,
  };

  constructor(
    private readonly pool: Pool,
    private readonly partitions: PartitionManager,
    options: LogWriterOptions = {},
  ) {
    this.maxInflight = options.maxInflightRecords ?? 20_000;
    this.all = options.mode === "all";
    this.maxPerTrace = this.all
      ? (options.allMaxPerTrace ?? 1_000)
      : (options.maxPerTrace ?? MAX_LOGS_PER_TRACE);
    this.maxPerMinute = options.maxPerMinute ?? 30_000;
    this.now = options.now ?? Date.now;
    this.retryAfterSeconds = options.retryAfterSeconds ?? 5;
  }

  stats(): LogWriterStats {
    return { inflightRecords: this.inflight, ...this.counters };
  }

  /** Stops accepting batches (each is then refused busy). */
  close(): void {
    this.closed = true;
  }

  async write(batch: IngestLogBatch): Promise<void> {
    if (this.closed) throw new IngestBusyError(this.retryAfterSeconds);
    let count = 0;
    for (const rl of batch.resourceLogs) count += rl.records.length;
    if (count === 0) return;
    // A batch larger than the whole allowance is still taken when nothing else is in flight.
    if (this.inflight > 0 && this.inflight + count > this.maxInflight) {
      this.counters.busyRejections++;
      throw new IngestBusyError(this.retryAfterSeconds);
    }
    this.inflight += count;
    try {
      await this.store(batch);
    } catch (error) {
      if (isTransient(error)) {
        throw new IngestBusyError(this.retryAfterSeconds);
      }
      throw error;
    } finally {
      this.inflight -= count;
    }
  }

  private async store(batch: IngestLogBatch): Promise<void> {
    const rows: LogRow[] = [];
    const seen = new Map<string, number>();
    let invalid = 0;
    for (const rl of batch.resourceLogs) {
      const { serviceName, environment } = deriveResource(rl.resource);
      for (const record of rl.records) {
        // The mapper already drops these in `trace` mode; the writer holds the rule too.
        if (!this.all && record.traceId === "") continue;
        const row = rowOf(record, serviceName, environment);
        if (row === null) {
          invalid++;
          continue;
        }
        // Identical lines in one batch (same millisecond) are real repeats: the dedupe key
        // includes how often the same base hash was already seen in this batch, so a retry
        // of the same payload still dedupes while genuine repeats are all kept.
        const ordinal = seen.get(row.hash) ?? 0;
        seen.set(row.hash, ordinal + 1);
        if (ordinal > 0) {
          row.hash = createHash("sha256")
            .update(`${row.hash}:${ordinal}`)
            .digest("hex");
        }
        rows.push(row);
      }
    }

    const { first, last } = this.partitions.acceptedLogDays();
    const inRange = rows.filter((r) => r.day >= first && r.day <= last);
    await this.partitions.ensureDays(new Set(inRange.map((r) => r.day)));
    let storable = inRange.filter((r) => this.partitions.hasDay(r.day));
    const outOfRange = invalid + rows.length - storable.length;
    this.counters.outOfRange += outOfRange;
    const drops = new Map<LogDropReason, number>();
    if (outOfRange > 0) drops.set("out_of_range", outOfRange);
    // The per-minute budget is reserved here (so concurrent batches see it) and given back below
    // for lines that were not stored: a failed transaction, duplicates, lines over the trace cap.
    let reservedMinute = -1;
    let reserved = 0;
    if (this.all && storable.length > 0) {
      const minute = Math.floor(this.now() / 60_000);
      if (minute !== this.minute) {
        this.minute = minute;
        this.minuteCount = 0;
      }
      const room = Math.max(0, this.maxPerMinute - this.minuteCount);
      if (storable.length > room) {
        const over = storable.length - room;
        storable = storable.slice(0, room);
        this.counters.droppedRateCap += over;
        drops.set("rate_cap", over);
      }
      this.minuteCount += storable.length;
      reservedMinute = minute;
      reserved = storable.length;
    }
    const refund = (stored: number): void => {
      if (reserved > stored && reservedMinute === this.minute) {
        this.minuteCount = Math.max(0, this.minuteCount - (reserved - stored));
      }
      reserved = 0;
    };
    if (storable.length === 0) {
      await this.recordDrops(drops);
      return;
    }

    // By trace, oldest line first: the first `maxPerTrace` lines of a trace are the ones kept.
    const byTrace = new Map<string, LogRow[]>();
    const traceless: LogRow[] = [];
    for (const r of storable) {
      if (r.traceId === "") {
        traceless.push(r);
        continue;
      }
      let list = byTrace.get(r.traceId);
      if (list === undefined) {
        list = [];
        byTrace.set(r.traceId, list);
      }
      list.push(r);
    }
    const traceIds = [...byTrace.keys()].sort();
    for (const list of byTrace.values()) {
      list.sort((a, b) =>
        a.timeNs < b.timeNs ? -1 : a.timeNs > b.timeNs ? 1 : 0,
      );
    }

    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      refund(0);
      throw error;
    }
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      // In lock key order, so two transactions never wait on each other in a cycle.
      await client.query(
        `SELECT pg_advisory_xact_lock($1, h)
           FROM (SELECT DISTINCT hashtext(t) AS h FROM unnest($2::text[]) t) s
          ORDER BY h`,
        [LOGS_LOCK_CLASS, traceIds],
      );
      const { rows: counts } = await client.query<{
        trace_id: string;
        n: number;
      }>(
        `SELECT trace_id, count(*)::int AS n FROM logs
          WHERE trace_id = ANY($1::text[]) GROUP BY trace_id`,
        [traceIds],
      );
      const held = new Map(counts.map((c) => [c.trace_id, c.n]));
      const insert: LogRow[] = [];
      let overCap = 0;
      for (const traceId of traceIds) {
        const list = byTrace.get(traceId) as LogRow[];
        const room = Math.max(0, this.maxPerTrace - (held.get(traceId) ?? 0));
        insert.push(...list.slice(0, room));
        overCap += Math.max(0, list.length - room);
      }
      insert.push(...traceless);
      const inserted = await this.insert(client, insert);
      await client.query("COMMIT");
      refund(inserted);
      if (overCap > 0) drops.set("trace_cap", overCap);
      this.counters.writtenLogs += inserted;
      this.counters.duplicateLogs += insert.length - inserted;
      this.counters.droppedOverCap += overCap;
    } catch (error) {
      // Nothing was stored (or a failed COMMIT stored nothing): the budget is not spent.
      refund(0);
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        broken = rollbackError as Error;
      }
      throw error;
    } finally {
      client.release(broken);
    }
    await this.recordDrops(drops);
  }

  /** Adds the drops to today's `log_drops` rows. Statistics only: a failure never fails the export. */
  private async recordDrops(drops: Map<LogDropReason, number>): Promise<void> {
    if (drops.size === 0) return;
    try {
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const reasons = [...drops.keys()];
      await this.pool.query(
        `INSERT INTO log_drops (day, reason, dropped)
         SELECT $1::date, r, n FROM unnest($2::text[], $3::bigint[]) AS u(r, n)
         ON CONFLICT (day, reason) DO UPDATE SET dropped = log_drops.dropped + EXCLUDED.dropped`,
        [day, reasons, reasons.map((r) => drops.get(r) as number)],
      );
    } catch {
      // Counted in memory (`stats()`); the persisted count may miss this batch.
    }
  }

  private async insert(client: PoolClient, rows: LogRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const col = <T>(f: (r: LogRow) => T): T[] => rows.map(f);
    const result = await client.query(
      `INSERT INTO logs (
         trace_id, span_id, time, time_ns, severity_number, severity_text, body, context,
         service_name, record_hash, truncated, environment)
       SELECT * FROM unnest(
         $1::text[], $2::text[], $3::timestamptz[], $4::bigint[], $5::int[], $6::text[],
         $7::text[], $8::text[], $9::text[], $10::text[], $11::boolean[], $12::text[])
       ON CONFLICT DO NOTHING`,
      [
        col((r) => r.traceId),
        col((r) => r.spanId),
        col((r) => r.time),
        col((r) => r.timeNs.toString()),
        col((r) => r.severityNumber),
        col((r) => r.severityText),
        col((r) => r.body),
        col((r) => r.context),
        col((r) => r.serviceName),
        col((r) => r.hash),
        col((r) => r.truncated),
        col((r) => r.environment),
      ],
    );
    return result.rowCount ?? 0;
  }
}
