/**
 * Stores metric points per minute (issue #18, D-105): the `metric_minutes` table
 * (migrations/0020_metric_minutes.sql). Reached only with `NESTRIX_METRICS=on`.
 *
 * Aggregation on write. A batch's points are first combined per row (series and minute) in memory,
 * then written with one `INSERT … ON CONFLICT DO UPDATE` that merges into a row already stored:
 * - gauge: count, sum, min and max add up; the newest point's value is `last_value`;
 * - cumulative counter or histogram: the newest point wins (a retried export changes nothing);
 * - delta counter or histogram: values and bucket counts add up. A retried delta export is counted
 *   twice (as with any OTLP backend that does not deduplicate); Nestrix's own export is cumulative.
 * Rates and increases are computed at query time from consecutive rows (`query/metrics.service.ts`),
 * so no per-series state is kept between exports and several server instances behind one address
 * store the same thing.
 *
 * Bounds:
 * - series: at most `maxSeriesPerService` series per service and `maxSeries` in all are active at
 *   once (seen within `activeWindowMs`, one hour) in this process; a point of a further series is
 *   dropped and counted (`overSeriesCap`). Restarted instances get a new `service.instance.id`, so
 *   their old series stop counting an hour after their last point. The bound is per server process:
 *   with several server instances, a service can hold up to that many series on each.
 * - age: a point older than two hours is dropped (`outOfRange`), so a row exists only for a recent
 *   minute; rows are therefore bounded by the series cap x retention minutes;
 * - days: a point older than retention, or more than two days ahead, is dropped (`outOfRange`); a
 *   missing day partition within retention is created; partitions go with the spans' retention;
 * - in flight: at most `maxInflightPoints` points are being written at once; a batch beyond it is
 *   refused with `IngestBusyError` (the receiver answers 503 with `Retry-After`, as for spans).
 *
 * Transient database failures reject with `IngestBusyError`, like the span writer.
 */
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  IngestBusyError,
  type IngestMetricBatch,
  type IngestMetricPoint,
  type IngestMetricWriteResult,
  type MetricDropCounts,
} from "../ingest/model.js";
import { MAX_NS } from "./derive.js";
import { type PartitionManager, utcDay } from "./partitions.js";
import { isTransient } from "./writer.js";

const MINUTE_MS = 60_000;
/** A point older than this is dropped (`outOfRange`): rows stay near the series cap x retention minutes. */
const MAX_POINT_AGE_MS = 2 * 3_600_000;
const MAX_SERVICE_LENGTH = 256;

export interface MetricWriterOptions {
  /** Points being written at once before `write` answers busy. Default 50 000. */
  maxInflightPoints?: number;
  /** `Retry-After` given with `IngestBusyError`. Default 5. */
  retryAfterSeconds?: number;
  /** Active series per service. Default 2 000 (`NESTRIX_METRICS_MAX_SERIES_PER_SERVICE`). */
  maxSeriesPerService?: number;
  /** Active series in all. Default 20 000 (`NESTRIX_METRICS_MAX_SERIES`). */
  maxSeries?: number;
  /** A series not seen for this long stops counting against the caps. Default one hour. */
  activeWindowMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export interface MetricWriterStats {
  inflightPoints: number;
  /** Points stored (merged into a row). */
  storedPoints: number;
  /** Points dropped because their series was over a cap. */
  overSeriesCap: number;
  /** Points outside the stored days. */
  outOfRange: number;
  /** Points rejected as invalid by the receiver (partial success). */
  rejectedPoints: number;
  /** Points the receiver discarded, by reason (`IngestMetricBatch.dropped`). */
  dropped: MetricDropCounts;
  busyRejections: number;
  /** Series currently counted against the caps. */
  activeSeries: number;
}

/**
 * The active series per service, with the time each was last seen. Pruned lazily: when a cap is
 * reached, at most once every 10 s per service (and in all).
 */
export class SeriesLimiter {
  private readonly services = new Map<string, Map<string, number>>();
  private readonly lastPrune = new Map<string, number>();
  private lastGlobalPrune = Number.NEGATIVE_INFINITY;
  private total = 0;

  constructor(
    private readonly perService: number,
    private readonly overall: number,
    private readonly windowMs: number,
  ) {}

  get active(): number {
    return this.total;
  }

  /** Whether a point of `series` in `service` may be stored at `nowMs`. */
  admit(service: string, series: string, nowMs: number): boolean {
    let known = this.services.get(service);
    const seen = known?.get(series);
    if (known !== undefined && seen !== undefined) {
      known.set(series, nowMs);
      return true;
    }
    if (known !== undefined && known.size >= this.perService) {
      this.prune(service, known, nowMs);
      if (known.size >= this.perService) return false;
    }
    if (this.total >= this.overall) {
      if (nowMs - this.lastGlobalPrune >= 10_000) {
        this.lastGlobalPrune = nowMs;
        for (const [name, map] of this.services)
          this.prune(name, map, nowMs, true);
      }
      if (this.total >= this.overall) return false;
    }
    if (known === undefined) {
      known = new Map();
      this.services.set(service, known);
    }
    known.set(series, nowMs);
    this.total++;
    return true;
  }

  private prune(
    service: string,
    map: Map<string, number>,
    nowMs: number,
    force = false,
  ): void {
    const last = this.lastPrune.get(service) ?? Number.NEGATIVE_INFINITY;
    if (!force && nowMs - last < 10_000) return;
    this.lastPrune.set(service, nowMs);
    for (const [series, seen] of map) {
      if (nowMs - seen > this.windowMs) {
        map.delete(series);
        this.total--;
      }
    }
    if (map.size === 0) {
      this.services.delete(service);
      this.lastPrune.delete(service);
    }
  }
}

/** One `metric_minutes` row being written. */
interface Row {
  minute: number;
  day: number;
  service: string;
  instance: string;
  metric: string;
  seriesKey: string;
  attributes: string;
  kind: IngestMetricPoint["kind"];
  temporality: IngestMetricPoint["temporality"];
  timeNs: bigint;
  startNs: bigint;
  last: number | null;
  sum: number | null;
  count: number | null;
  min: number | null;
  max: number | null;
  bounds: number[] | null;
  buckets: number[] | null;
  histCount: number | null;
  histSum: number | null;
}

function seriesKey(point: IngestMetricPoint): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        point.attributesKey,
        point.temporality,
        point.bounds ?? null,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

function rowOf(
  point: IngestMetricPoint,
  service: string,
  instance: string,
  key: string,
): Row | null {
  const ns = point.timeUnixNano;
  if (ns <= 0n || ns > MAX_NS) return null;
  const ms = Number(ns / 1_000_000n);
  const row: Row = {
    minute: Math.floor(ms / MINUTE_MS) * MINUTE_MS,
    day: utcDay(ms),
    service,
    instance,
    metric: point.metric,
    seriesKey: key,
    attributes: JSON.stringify(point.attributes),
    kind: point.kind,
    temporality: point.temporality,
    timeNs: ns,
    startNs: point.startTimeUnixNano,
    last: null,
    sum: null,
    count: null,
    min: null,
    max: null,
    bounds: null,
    buckets: null,
    histCount: null,
    histSum: null,
  };
  if (point.kind === "gauge") {
    row.last = point.value;
    row.sum = point.value;
    row.count = 1;
    row.min = point.value;
    row.max = point.value;
  } else if (point.kind === "counter") {
    if (point.temporality === "cumulative") row.last = point.value;
    else row.sum = point.value;
  } else {
    row.bounds = point.bounds ?? [];
    row.buckets = [...(point.bucketCounts ?? [])];
    row.histCount = point.count ?? 0;
    row.histSum = point.sum ?? null;
  }
  return row;
}

/** Merges `b` into `a` (same row key) with the rules of the SQL upsert. */
/** Keeps a merged sum inside what the mapper accepts, so float8 sums in Postgres cannot overflow. */
function cap(v: number): number {
  return Math.max(-1e100, Math.min(1e100, v));
}

function mergeRow(a: Row, b: Row): void {
  const newer = b.timeNs >= a.timeNs;
  const cumulative = a.kind === "gauge" || a.temporality === "cumulative";
  if (a.kind === "gauge") {
    a.sum = cap((a.sum ?? 0) + (b.sum ?? 0));
    a.count = (a.count ?? 0) + (b.count ?? 0);
    a.min = Math.min(a.min ?? Infinity, b.min ?? Infinity);
    a.max = Math.max(a.max ?? -Infinity, b.max ?? -Infinity);
    if (newer) a.last = b.last;
  } else if (a.kind === "counter") {
    if (cumulative) {
      if (newer) a.last = b.last;
    } else {
      a.sum = cap((a.sum ?? 0) + (b.sum ?? 0));
    }
  } else if (cumulative) {
    if (newer) {
      a.buckets = b.buckets;
      a.histCount = b.histCount;
      a.histSum = b.histSum;
    }
  } else {
    const into = a.buckets ?? [];
    const from = b.buckets ?? [];
    a.buckets = into.map((v, i) => v + (from[i] ?? 0));
    a.histCount = (a.histCount ?? 0) + (b.histCount ?? 0);
    a.histSum =
      a.histSum === null || b.histSum === null
        ? null
        : cap(a.histSum + b.histSum);
  }
  if (cumulative) {
    if (newer) a.startNs = b.startNs;
  } else if (b.startNs < a.startNs) {
    a.startNs = b.startNs;
  }
  if (newer) a.timeNs = b.timeNs;
}

function arrayLiteral(values: number[] | null): string | null {
  return values === null ? null : `{${values.join(",")}}`;
}

/** Row keys in one stable order, so concurrent writers lock rows in the same order. */
function rowKey(r: Row): string {
  return `${r.service}\u0000${r.metric}\u0000${r.instance}\u0000${r.seriesKey}\u0000${r.minute}`;
}

const UPSERT = `
INSERT INTO metric_minutes AS m (
  minute, service_name, instance_id, metric_name, series_key, attributes, kind, temporality,
  time_ns, start_ns, last_value, sum_value, count_value, min_value, max_value, bounds, buckets,
  hist_count, hist_sum)
SELECT u.minute, u.service, u.instance, u.metric, u.series, u.attrs::jsonb, u.kind, u.temp,
       u.time_ns, u.start_ns, u.last, u.sum, u.count, u.min, u.max, u.bounds::float8[],
       u.buckets::float8[], u.hcount, u.hsum
  FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
              $7::text[], $8::text[], $9::bigint[], $10::bigint[], $11::float8[], $12::float8[],
              $13::bigint[], $14::float8[], $15::float8[], $16::text[], $17::text[],
              $18::float8[], $19::float8[])
    AS u(minute, service, instance, metric, series, attrs, kind, temp, time_ns, start_ns, last,
         sum, count, min, max, bounds, buckets, hcount, hsum)
ON CONFLICT (service_name, metric_name, instance_id, series_key, minute) DO UPDATE SET
  last_value = CASE WHEN EXCLUDED.time_ns >= m.time_ns THEN EXCLUDED.last_value ELSE m.last_value END,
  sum_value = CASE WHEN m.kind = 'gauge' OR (m.kind = 'counter' AND m.temporality = 'delta')
                   THEN m.sum_value + EXCLUDED.sum_value ELSE m.sum_value END,
  count_value = CASE WHEN m.kind = 'gauge' THEN m.count_value + EXCLUDED.count_value
                     ELSE m.count_value END,
  min_value = LEAST(m.min_value, EXCLUDED.min_value),
  max_value = GREATEST(m.max_value, EXCLUDED.max_value),
  buckets = CASE
    WHEN m.kind <> 'histogram' THEN NULL
    WHEN m.temporality = 'delta' THEN ARRAY(
      SELECT x.a + x.b FROM unnest(m.buckets, EXCLUDED.buckets) WITH ORDINALITY AS x(a, b, i)
       ORDER BY x.i)
    WHEN EXCLUDED.time_ns >= m.time_ns THEN EXCLUDED.buckets
    ELSE m.buckets END,
  hist_count = CASE
    WHEN m.kind <> 'histogram' THEN NULL
    WHEN m.temporality = 'delta' THEN m.hist_count + EXCLUDED.hist_count
    WHEN EXCLUDED.time_ns >= m.time_ns THEN EXCLUDED.hist_count
    ELSE m.hist_count END,
  hist_sum = CASE
    WHEN m.kind <> 'histogram' THEN NULL
    WHEN m.temporality = 'delta' THEN m.hist_sum + EXCLUDED.hist_sum
    WHEN EXCLUDED.time_ns >= m.time_ns THEN EXCLUDED.hist_sum
    ELSE m.hist_sum END,
  start_ns = CASE
    WHEN m.kind = 'gauge' OR m.temporality = 'cumulative' THEN
      CASE WHEN EXCLUDED.time_ns >= m.time_ns THEN EXCLUDED.start_ns ELSE m.start_ns END
    ELSE LEAST(m.start_ns, EXCLUDED.start_ns) END,
  time_ns = GREATEST(m.time_ns, EXCLUDED.time_ns)`;

export class PostgresMetricWriter {
  private readonly maxInflight: number;
  private readonly retryAfterSeconds: number;
  private readonly now: () => number;
  private readonly limiter: SeriesLimiter;
  private inflight = 0;
  private closed = false;
  private readonly counters = {
    storedPoints: 0,
    overSeriesCap: 0,
    outOfRange: 0,
    rejectedPoints: 0,
    busyRejections: 0,
  };
  private readonly dropped: MetricDropCounts = {
    unsupportedType: 0,
    notStored: 0,
    typeMismatch: 0,
    noRecordedValue: 0,
  };

  constructor(
    private readonly pool: Pool,
    private readonly partitions: PartitionManager,
    options: MetricWriterOptions = {},
  ) {
    this.maxInflight = options.maxInflightPoints ?? 50_000;
    this.retryAfterSeconds = options.retryAfterSeconds ?? 5;
    this.now = options.now ?? Date.now;
    this.limiter = new SeriesLimiter(
      options.maxSeriesPerService ?? 2_000,
      options.maxSeries ?? 20_000,
      options.activeWindowMs ?? 3_600_000,
    );
  }

  stats(): MetricWriterStats {
    return {
      inflightPoints: this.inflight,
      ...this.counters,
      dropped: { ...this.dropped },
      activeSeries: this.limiter.active,
    };
  }

  /** Stops accepting batches (each is then refused busy). */
  close(): void {
    this.closed = true;
  }

  async write(batch: IngestMetricBatch): Promise<IngestMetricWriteResult> {
    if (this.closed) throw new IngestBusyError(this.retryAfterSeconds);
    let count = 0;
    for (const rm of batch.resourceMetrics) count += rm.points.length;
    // A batch larger than the whole allowance is still taken when nothing else is in flight.
    if (
      count > 0 &&
      this.inflight > 0 &&
      this.inflight + count > this.maxInflight
    ) {
      this.counters.busyRejections++;
      throw new IngestBusyError(this.retryAfterSeconds);
    }
    // Counted once the batch is accepted (a busy batch will be sent again).
    this.counters.rejectedPoints += batch.rejectedDataPoints;
    for (const k of Object.keys(this.dropped) as (keyof MetricDropCounts)[]) {
      this.dropped[k] += batch.dropped[k] ?? 0;
    }
    if (count === 0) return { overSeriesCap: 0, outOfRange: 0 };
    this.inflight += count;
    try {
      return await this.store(batch);
    } catch (error) {
      if (isTransient(error)) {
        throw new IngestBusyError(this.retryAfterSeconds);
      }
      throw error;
    } finally {
      this.inflight -= count;
    }
  }

  private async store(
    batch: IngestMetricBatch,
  ): Promise<IngestMetricWriteResult> {
    const { first, last } = this.partitions.acceptedDays();
    const nowMs = this.now();
    let outOfRange = 0;
    let overCap = 0;
    const candidates: { row: Row; series: string }[] = [];
    for (const rm of batch.resourceMetrics) {
      for (const point of rm.points) {
        const key = seriesKey(point);
        const row = rowOf(
          point,
          rm.serviceName.slice(0, MAX_SERVICE_LENGTH),
          rm.instanceId,
          key,
        );
        if (
          row === null ||
          row.day < first ||
          row.day > last ||
          row.minute < nowMs - MAX_POINT_AGE_MS
        ) {
          outOfRange++;
          continue;
        }
        candidates.push({
          row,
          series: `${rm.instanceId}\u0000${point.metric}\u0000${key}`,
        });
      }
    }
    await this.partitions.ensureDays(new Set(candidates.map((c) => c.row.day)));

    const rows = new Map<string, Row>();
    let stored = 0;
    for (const { row, series } of candidates) {
      if (!this.partitions.hasDay(row.day)) {
        outOfRange++;
        continue;
      }
      if (!this.limiter.admit(row.service, series, nowMs)) {
        overCap++;
        continue;
      }
      stored++;
      const key = rowKey(row);
      const existing = rows.get(key);
      if (existing === undefined) rows.set(key, row);
      else mergeRow(existing, row);
    }
    this.counters.outOfRange += outOfRange;
    this.counters.overSeriesCap += overCap;
    if (rows.size > 0) {
      await this.upsert(
        [...rows.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([, r]) => r),
      );
    }
    this.counters.storedPoints += stored;
    return { overSeriesCap: overCap, outOfRange };
  }

  private async upsert(rows: Row[]): Promise<void> {
    const col = <T>(f: (r: Row) => T): T[] => rows.map(f);
    await this.pool.query(UPSERT, [
      col((r) => new Date(r.minute).toISOString()),
      col((r) => r.service),
      col((r) => r.instance),
      col((r) => r.metric),
      col((r) => r.seriesKey),
      col((r) => r.attributes),
      col((r) => r.kind),
      col((r) => r.temporality),
      col((r) => r.timeNs.toString()),
      col((r) => r.startNs.toString()),
      col((r) => r.last),
      col((r) => r.sum),
      col((r) => r.count),
      col((r) => r.min),
      col((r) => r.max),
      col((r) => arrayLiteral(r.bounds)),
      col((r) => arrayLiteral(r.buckets)),
      col((r) => r.histCount),
      col((r) => r.histSum),
    ]);
  }
}
