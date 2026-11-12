/**
 * The ingest writer: the receiver's `IngestSink`, storing batches in Postgres.
 *
 * Flow. `write()` queues the batch and returns a promise settled when the batch is durable (or
 * failed). One worker loop takes queued batches, up to `maxSpansPerTransaction` spans together
 * (group commit: several small exports share one transaction), and writes them:
 *
 * 1. resources: deduplicated by hash, with an in-process cache of hash → id; unknown hashes are
 *    inserted (`ON CONFLICT DO NOTHING`) and read back, outside the transaction (idempotent);
 * 2. partitions: spans for a day with no partition but within retention get one created; spans
 *    older than retention or more than two days ahead are dropped and counted (`outOfRange`);
 * 3. one transaction: spans (one multi-row `INSERT … SELECT FROM unnest(…)`, `ON CONFLICT DO
 *    NOTHING` on the primary key, so a retried export does not duplicate), then the rollups and
 *    trace summaries computed from the spans that were actually inserted (`RETURNING`), then
 *    `services`.
 *
 * Capacity. The queue holds at most `maxQueueSpans` spans (waiting plus in flight). A batch that
 * does not fit is rejected at once with `IngestBusyError(retryAfterSeconds)` (the receiver answers
 * 503 with `Retry-After`); a batch larger than the whole queue is still accepted when the queue is
 * empty, so it is never refused forever.
 *
 * Failures. A transient database failure (connection loss, too many connections, shutdown,
 * deadlock or serialisation failure after one retry, lock timeout) rejects the group's batches
 * with `IngestBusyError`, so OTLP exporters retry them. Any other failure of a group of several
 * batches is retried batch by batch, so one bad batch fails alone. Nothing here throws to a caller
 * or leaves a promise rejection unhandled.
 */
import type { Pool, PoolClient } from "pg";
import {
  type IngestBatch,
  IngestBusyError,
  type IngestLogBatch,
  type IngestSink,
} from "../ingest/model.js";
import {
  deriveResource,
  deriveSpan,
  minuteDay,
  type ResourceRow,
  type SpanRow,
  UNMATCHED_ROUTE,
} from "./derive.js";
import { bucketIndex, emptyHistogram } from "./histogram.js";
import { type LogWriterOptions, PostgresLogWriter } from "./logs.js";
import type { PartitionManager } from "./partitions.js";
import { upsertTraces } from "./traces.js";

export interface WriterOptions {
  /** Spans waiting or in flight before `write` answers busy. Default 50 000. */
  maxQueueSpans?: number;
  /** Spans per transaction (group commit). Default 5 000. */
  maxSpansPerTransaction?: number;
  /** `Retry-After` given with `IngestBusyError`. Default 5. */
  retryAfterSeconds?: number;
  /** Resource hash → id entries cached. Default 10 000. */
  resourceCacheSize?: number;
  /** Called with failures worth a log line (never with a busy rejection). */
  onError?: (error: unknown, context: string) => void;
  /** The log writer behind `writeLogs` (P9-07, `logs.ts`). */
  logs?: LogWriterOptions;
}

export interface WriterStats {
  queuedSpans: number;
  queuedBatches: number;
  /** Spans inserted. */
  writtenSpans: number;
  /** Spans already stored (a retried export). */
  duplicateSpans: number;
  /** Spans outside the stored days (older than retention, or more than two days ahead). */
  outOfRangeSpans: number;
  /** Spans whose times could not be stored. */
  invalidSpans: number;
  /** Batches rejected busy because the queue was full. */
  busyRejections: number;
  /** Batches that failed for another reason. */
  failedBatches: number;
  transactions: number;
}

interface Pending {
  batch: IngestBatch;
  spans: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const TRANSIENT_SQLSTATE_CLASSES = ["08", "53", "57"];
const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "55P03"]);
const TRANSIENT_NODE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/** A failure an exporter should retry later (the database is unavailable or contended). */
export function isTransient(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  if (TRANSIENT_SQLSTATES.has(code) || TRANSIENT_NODE_CODES.has(code)) {
    return true;
  }
  if (
    code.length === 5 &&
    TRANSIENT_SQLSTATE_CLASSES.includes(code.slice(0, 2))
  ) {
    return true;
  }
  const message = typeof e?.message === "string" ? e.message : "";
  return /Connection terminated|timeout exceeded when trying to connect|connection timeout|Client has encountered a connection error/i.test(
    message,
  );
}

function isRetryableOnce(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "40P01" || code === "40001";
}

interface Rollup {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  hist: number[];
}

function addToRollup(
  map: Map<string, Rollup & { key: string[] }>,
  key: string[],
  s: SpanRow,
  error: boolean,
): void {
  const k = JSON.stringify(key);
  let r = map.get(k);
  if (r === undefined) {
    r = {
      key,
      count: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
      hist: emptyHistogram(),
    };
    map.set(k, r);
  }
  const ms =
    Number.isFinite(s.durationMs) && s.durationMs > 0 ? s.durationMs : 0;
  r.count++;
  if (error) r.errors++;
  r.totalMs += ms;
  if (ms > r.maxMs) r.maxMs = ms;
  const b = bucketIndex(ms);
  r.hist[b] = (r.hist[b] ?? 0) + 1;
}

const SERVICES_REFRESH_MS = 60_000;

export class PostgresIngestSink implements IngestSink {
  private readonly maxQueueSpans: number;
  private readonly maxSpansPerTransaction: number;
  private readonly retryAfterSeconds: number;
  private readonly resourceCacheSize: number;
  private readonly queue: Pending[] = [];
  private queuedSpans = 0;
  private working = false;
  private closed = false;
  private idleWaiters: (() => void)[] = [];
  /** `writeLogs` (P9-07): log records next to their traces, written outside the span queue. */
  readonly logs: PostgresLogWriter;
  private readonly resourceIds = new Map<string, number>();
  private readonly servicesWritten = new Map<string, number>();
  private readonly counters = {
    writtenSpans: 0,
    duplicateSpans: 0,
    outOfRangeSpans: 0,
    invalidSpans: 0,
    busyRejections: 0,
    failedBatches: 0,
    transactions: 0,
  };

  constructor(
    private readonly pool: Pool,
    private readonly partitions: PartitionManager,
    private readonly options: WriterOptions = {},
  ) {
    this.maxQueueSpans = options.maxQueueSpans ?? 50_000;
    this.maxSpansPerTransaction = options.maxSpansPerTransaction ?? 5_000;
    this.retryAfterSeconds = options.retryAfterSeconds ?? 5;
    this.resourceCacheSize = options.resourceCacheSize ?? 10_000;
    this.logs = new PostgresLogWriter(pool, partitions, {
      retryAfterSeconds: this.retryAfterSeconds,
      ...options.logs,
    });
  }

  /** Stores log records next to their traces (`logs.ts`). Same contract as `write`. */
  async writeLogs(batch: IngestLogBatch): Promise<void> {
    try {
      await this.logs.write(batch);
    } catch (error) {
      if (!(error instanceof IngestBusyError))
        this.report(error, "writer.logs");
      throw error;
    }
  }

  write(batch: IngestBatch): Promise<void> {
    try {
      if (this.closed) {
        return Promise.reject(new IngestBusyError(this.retryAfterSeconds));
      }
      let spans = 0;
      for (const rs of batch.resourceSpans) spans += rs.spans.length;
      if (spans === 0) return Promise.resolve();
      if (this.queue.length > 0 || this.working) {
        if (this.queuedSpans + spans > this.maxQueueSpans) {
          this.counters.busyRejections++;
          return Promise.reject(new IngestBusyError(this.retryAfterSeconds));
        }
      }
      return new Promise<void>((resolve, reject) => {
        this.queue.push({ batch, spans, resolve, reject });
        this.queuedSpans += spans;
        this.kick();
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  stats(): WriterStats {
    return {
      queuedSpans: this.queuedSpans,
      queuedBatches: this.queue.length,
      ...this.counters,
    };
  }

  /** Resolves when the queue is empty and nothing is in flight. */
  whenIdle(): Promise<void> {
    if (!this.working && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * Stops accepting batches, waits up to `timeoutMs` for the queue to drain, then rejects what is
   * still waiting with `IngestBusyError`.
   */
  async close(timeoutMs = 10_000): Promise<void> {
    this.closed = true;
    this.logs.close();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.whenIdle(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
    for (const p of this.queue.splice(0)) {
      this.queuedSpans -= p.spans;
      p.reject(new IngestBusyError(this.retryAfterSeconds));
    }
  }

  private kick(): void {
    if (this.working) return;
    this.working = true;
    this.loop()
      .catch((error) => this.report(error, "writer.loop"))
      .finally(() => {
        this.working = false;
        if (this.queue.length > 0) {
          this.kick();
          return;
        }
        for (const w of this.idleWaiters.splice(0)) w();
      });
  }

  private async loop(): Promise<void> {
    while (this.queue.length > 0) {
      const group: Pending[] = [];
      let spans = 0;
      while (this.queue.length > 0) {
        const next = this.queue[0] as Pending;
        if (
          group.length > 0 &&
          spans + next.spans > this.maxSpansPerTransaction
        )
          break;
        this.queue.shift();
        group.push(next);
        spans += next.spans;
      }
      try {
        await this.writeGroup(group);
      } finally {
        this.queuedSpans -= spans;
      }
    }
  }

  /** Writes a group and settles each of its promises. Never throws. */
  private async writeGroup(group: Pending[]): Promise<void> {
    try {
      await this.writeBatches(group.map((p) => p.batch));
      for (const p of group) p.resolve();
      return;
    } catch (error) {
      if (isTransient(error)) {
        this.report(error, "writer.transient");
        for (const p of group)
          p.reject(new IngestBusyError(this.retryAfterSeconds));
        return;
      }
      if (group.length === 1) {
        this.counters.failedBatches++;
        this.report(error, "writer.batch");
        (group[0] as Pending).reject(error);
        return;
      }
    }
    // A non-transient failure of a group: one batch at a time, so a bad one fails alone.
    for (const p of group) {
      try {
        await this.writeBatches([p.batch]);
        p.resolve();
      } catch (error) {
        if (isTransient(error)) {
          p.reject(new IngestBusyError(this.retryAfterSeconds));
        } else {
          this.counters.failedBatches++;
          this.report(error, "writer.batch");
          p.reject(error);
        }
      }
    }
  }

  private report(error: unknown, context: string): void {
    try {
      this.options.onError?.(error, context);
    } catch {
      // A throwing logger must not break the writer.
    }
  }

  private async writeBatches(batches: IngestBatch[]): Promise<void> {
    // Derive rows and the distinct resources.
    const resources = new Map<string, ResourceRow>();
    const rows: SpanRow[] = [];
    let invalid = 0;
    for (const batch of batches) {
      for (const rs of batch.resourceSpans) {
        const resource = deriveResource(rs.resource);
        resources.set(resource.hash, resource);
        for (const span of rs.spans) {
          const row = deriveSpan(span, resource);
          if (row === null) invalid++;
          else rows.push(row);
        }
      }
    }

    // Days: drop what is outside the stored range, create missing partitions inside it.
    const { first, last } = this.partitions.acceptedDays();
    const inRange = rows.filter(
      (r) => r.startDay >= first && r.startDay <= last,
    );
    const outOfRange = rows.length - inRange.length;
    const days = new Set<number>();
    for (const r of inRange) {
      days.add(r.startDay);
      if (r.isRouteSpan || r.className !== null)
        days.add(minuteDay(r.endMinuteMs));
    }
    await this.partitions.ensureDays(days);
    const storable = inRange.filter((r) => this.partitions.hasDay(r.startDay));
    const unstorable = inRange.length - storable.length;

    const used = new Set(storable.map((s) => s.resourceHash));
    const resourceIds = await this.resolveResources(
      [...resources.values()].filter((r) => used.has(r.hash)),
    );

    // Deterministic order (primary key) so concurrent transactions lock rows in the same order.
    storable.sort((a, b) =>
      a.traceId < b.traceId
        ? -1
        : a.traceId > b.traceId
          ? 1
          : a.spanId < b.spanId
            ? -1
            : a.spanId > b.spanId
              ? 1
              : 0,
    );

    let attempt = 0;
    for (;;) {
      const client = await this.pool.connect();
      let broken: Error | undefined;
      try {
        await client.query("BEGIN");
        const inserted = await this.insertSpans(client, storable, resourceIds);
        await this.upsertRollups(client, inserted);
        await upsertTraces(client, inserted, resourceIds);
        const services = this.servicesDue(inserted);
        if (services.length > 0) {
          await client.query(
            `INSERT INTO services (name, last_seen)
               SELECT unnest($1::text[]), now()
             ON CONFLICT (name) DO UPDATE SET last_seen = EXCLUDED.last_seen`,
            [services],
          );
        }
        await client.query("COMMIT");
        this.counters.transactions++;
        this.counters.writtenSpans += inserted.length;
        this.counters.duplicateSpans += storable.length - inserted.length;
        this.counters.outOfRangeSpans += outOfRange + unstorable;
        this.counters.invalidSpans += invalid;
        const now = Date.now();
        for (const name of services) this.servicesWritten.set(name, now);
        return;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          broken = rollbackError as Error;
        }
        if (attempt === 0 && isRetryableOnce(error)) {
          attempt++;
          continue;
        }
        throw error;
      } finally {
        client.release(broken);
      }
    }
  }

  private servicesDue(inserted: readonly SpanRow[]): string[] {
    const now = Date.now();
    const names = new Set<string>();
    for (const s of inserted) {
      const at = this.servicesWritten.get(s.serviceName);
      if (at === undefined || now - at >= SERVICES_REFRESH_MS)
        names.add(s.serviceName);
    }
    return [...names].sort();
  }

  /** Hash → id for every given resource, inserting unknown ones. */
  private async resolveResources(
    resources: ResourceRow[],
  ): Promise<Map<string, number>> {
    const ids = new Map<string, number>();
    const missing: ResourceRow[] = [];
    for (const r of resources) {
      const id = this.resourceIds.get(r.hash);
      if (id !== undefined) ids.set(r.hash, id);
      else missing.push(r);
    }
    if (missing.length === 0) return ids;
    missing.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    await this.pool.query(
      `INSERT INTO resources (hash, service_name, service_version, attributes)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::jsonb[])
       ON CONFLICT (hash) DO NOTHING`,
      [
        missing.map((r) => r.hash),
        missing.map((r) => r.serviceName),
        missing.map((r) => r.serviceVersion),
        missing.map((r) => JSON.stringify(r.attributes)),
      ],
    );
    const { rows } = await this.pool.query<{ id: string; hash: string }>(
      "SELECT id::text AS id, hash FROM resources WHERE hash = ANY($1::text[])",
      [missing.map((r) => r.hash)],
    );
    if (this.resourceIds.size + rows.length > this.resourceCacheSize) {
      this.resourceIds.clear();
    }
    for (const r of rows) {
      const id = Number(r.id);
      ids.set(r.hash, id);
      this.resourceIds.set(r.hash, id);
    }
    for (const r of missing) {
      if (!ids.has(r.hash))
        throw new Error(`resource ${r.hash} was not stored`);
    }
    return ids;
  }

  /** Inserts the rows; returns those actually inserted (not already stored). */
  private async insertSpans(
    client: PoolClient,
    rows: SpanRow[],
    resourceIds: ReadonlyMap<string, number>,
  ): Promise<SpanRow[]> {
    if (rows.length === 0) return [];
    const col = <T>(f: (r: SpanRow) => T): T[] => rows.map(f);
    const result = await client.query<{
      trace_id: string;
      span_id: string;
      start_ns: string;
    }>(
      `INSERT INTO spans (
         trace_id, span_id, parent_span_id, resource_id, service_name, name, kind, start_time,
         start_ns, end_ns, duration_ns, status_code, status_message, scope, attributes, events,
         links, http_route, http_method, http_status, is_root, is_error, trace_type, user_id,
         class_name, method_name)
       SELECT * FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::bigint[], $5::text[], $6::text[], $7::text[],
         $8::timestamptz[], $9::bigint[], $10::bigint[], $11::bigint[], $12::text[], $13::text[],
         $14::text[], $15::jsonb[], $16::jsonb[], $17::jsonb[], $18::text[], $19::text[],
         $20::int[], $21::boolean[], $22::boolean[], $23::text[], $24::text[], $25::text[],
         $26::text[])
       ON CONFLICT DO NOTHING
       RETURNING trace_id, span_id, start_ns::text AS start_ns`,
      [
        col((r) => r.traceId),
        col((r) => r.spanId),
        col((r) => r.parentSpanId),
        col((r) => resourceIds.get(r.resourceHash) ?? null),
        col((r) => r.serviceName),
        col((r) => r.name),
        col((r) => r.kind),
        col((r) => r.startTime),
        col((r) => r.startNs.toString()),
        col((r) => r.endNs.toString()),
        col((r) => r.durationNs.toString()),
        col((r) => r.statusCode),
        col((r) => r.statusMessage),
        col((r) => r.scope),
        col((r) => r.attributesJson),
        col((r) => r.eventsJson),
        col((r) => r.linksJson),
        col((r) => r.httpRoute),
        col((r) => r.httpMethod),
        col((r) => r.httpStatus),
        col((r) => r.isRoot),
        col((r) => r.isError),
        col((r) => r.traceType),
        col((r) => r.userId),
        col((r) => r.className),
        col((r) => r.methodName),
      ],
    );
    if (result.rows.length === rows.length) return rows;
    const keys = new Set(
      result.rows.map((r) => `${r.trace_id}/${r.span_id}/${r.start_ns}`),
    );
    // A duplicate within this insert is inserted once: keep the first row with each key.
    const out: SpanRow[] = [];
    for (const r of rows) {
      const k = `${r.traceId}/${r.spanId}/${r.startNs}`;
      if (keys.delete(k)) out.push(r);
    }
    return out;
  }

  private async upsertRollups(
    client: PoolClient,
    inserted: readonly SpanRow[],
  ): Promise<void> {
    const routes = new Map<string, Rollup & { key: string[] }>();
    const classes = new Map<string, Rollup & { key: string[] }>();
    const kinds = new Map<string, string>();
    for (const s of inserted) {
      if (!this.partitions.hasDay(minuteDay(s.endMinuteMs))) continue;
      const minute = new Date(s.endMinuteMs).toISOString();
      if (s.isRouteSpan) {
        addToRollup(
          routes,
          [
            minute,
            s.serviceName,
            s.httpMethod as string,
            s.httpRoute ?? UNMATCHED_ROUTE,
          ],
          s,
          s.isRouteError,
        );
      }
      if (s.className !== null && s.methodName !== null) {
        const key = [minute, s.serviceName, s.className, s.methodName];
        addToRollup(classes, key, s, s.isError);
        kinds.set(JSON.stringify(key), s.classKind);
      }
    }
    const sorted = (m: Map<string, Rollup & { key: string[] }>) =>
      [...m.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, v]) => v);
    if (routes.size > 0) {
      const list = sorted(routes);
      await client.query(
        `INSERT INTO route_minutes AS r
           (minute, service_name, method, route, count, errors, total_ms, max_ms, hist)
         SELECT u.minute, u.service_name, u.method, u.route, u.count, u.errors, u.total_ms,
                u.max_ms, u.hist::int[]
           FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::int[],
                       $6::int[], $7::float8[], $8::float8[], $9::text[])
                AS u(minute, service_name, method, route, count, errors, total_ms, max_ms, hist)
         ON CONFLICT (minute, service_name, method, route) DO UPDATE SET
           count = r.count + EXCLUDED.count,
           errors = r.errors + EXCLUDED.errors,
           total_ms = r.total_ms + EXCLUDED.total_ms,
           max_ms = greatest(r.max_ms, EXCLUDED.max_ms),
           hist = nestrix_hist_add(r.hist, EXCLUDED.hist)`,
        [
          list.map((r) => r.key[0]),
          list.map((r) => r.key[1]),
          list.map((r) => r.key[2]),
          list.map((r) => r.key[3]),
          list.map((r) => r.count),
          list.map((r) => r.errors),
          list.map((r) => r.totalMs),
          list.map((r) => r.maxMs),
          list.map((r) => `{${r.hist.join(",")}}`),
        ],
      );
    }
    if (classes.size > 0) {
      const list = sorted(classes);
      await client.query(
        `INSERT INTO class_minutes AS c
           (minute, service_name, class_name, method_name, class_kind, count, errors, total_ms,
            max_ms, hist)
         SELECT u.minute, u.service_name, u.class_name, u.method_name, u.class_kind, u.count,
                u.errors, u.total_ms, u.max_ms, u.hist::int[]
           FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[],
                       $6::int[], $7::int[], $8::float8[], $9::float8[], $10::text[])
                AS u(minute, service_name, class_name, method_name, class_kind, count, errors,
                     total_ms, max_ms, hist)
         ON CONFLICT (minute, service_name, class_name, method_name) DO UPDATE SET
           class_kind = EXCLUDED.class_kind,
           count = c.count + EXCLUDED.count,
           errors = c.errors + EXCLUDED.errors,
           total_ms = c.total_ms + EXCLUDED.total_ms,
           max_ms = greatest(c.max_ms, EXCLUDED.max_ms),
           hist = nestrix_hist_add(c.hist, EXCLUDED.hist)`,
        [
          list.map((r) => r.key[0]),
          list.map((r) => r.key[1]),
          list.map((r) => r.key[2]),
          list.map((r) => r.key[3]),
          list.map((r) => kinds.get(JSON.stringify(r.key)) ?? "provider"),
          list.map((r) => r.count),
          list.map((r) => r.errors),
          list.map((r) => r.totalMs),
          list.map((r) => r.maxMs),
          list.map((r) => `{${r.hist.join(",")}}`),
        ],
      );
    }
  }
}
