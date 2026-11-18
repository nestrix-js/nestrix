/**
 * Maps a decoded `ExportMetricsServiceRequest` to the metric writer's `IngestMetricBatch` (issue
 * #18, D-105), against the catalog (`metrics/catalog.ts`).
 *
 * What is kept: Gauge, Sum (monotonic: a counter, cumulative or delta; non-monotonic cumulative: a
 * level, stored like a gauge) and Histogram with explicit buckets (cumulative or delta), for the
 * catalog's names, with the catalog's instrument type and unit. What is counted and discarded
 * (`dropped`, not an error: the sender did nothing wrong): ExponentialHistogram, Summary and
 * non-monotonic delta Sums (`unsupportedType`), names outside the catalog (`notStored`), a catalog
 * name with another type or unit (`typeMismatch`), points flagged "no recorded value".
 *
 * What is rejected (OTLP partial success, `rejectedDataPoints`): a point with no time, a time more
 * than a day ahead or past `int8`, a delta point without a start time, a start after the time, no
 * value or a value that is not finite (NaN, ±Infinity), an unspecified temporality, and a histogram
 * whose bounds are not finite and strictly increasing, number more than `MAX_HISTOGRAM_BOUNDS`, or do
 * not match its bucket count. A rejected point never rejects the rest of the request.
 *
 * Attributes: only the catalog's keys are read, into null-prototype objects (a `__proto__` key is an
 * ordinary key), values as strings cut to `MAX_METRIC_ATTRIBUTE_LENGTH`. Points of one metric that
 * end up with the same attributes, time and bounds are merged (`CatalogEntry.merge`).
 */

import {
  type CatalogEntry,
  type CatalogKind,
  catalogEntry,
  MAX_HISTOGRAM_BOUNDS,
  MAX_METRIC_ATTRIBUTE_LENGTH,
} from "../metrics/catalog.js";
import type { ExportMetricsServiceRequest } from "../proto/gen/opentelemetry/proto/collector/metrics/v1/metrics_service_pb.js";
import type { AnyValue } from "../proto/gen/opentelemetry/proto/common/v1/common_pb.js";
import {
  AggregationTemporality,
  type HistogramDataPoint,
  type Metric,
  type NumberDataPoint,
} from "../proto/gen/opentelemetry/proto/metrics/v1/metrics_pb.js";
import { environmentOf } from "../storage/derive.js";
import { attributes, MAX_FUTURE_NS, text } from "./map.js";
import type {
  IngestMetricBatch,
  IngestMetricPoint,
  IngestResourceMetrics,
  MetricDropCounts,
} from "./model.js";

export const UNKNOWN_SERVICE = "unknown_service";
/** `service.instance.id` is cut to this. */
export const MAX_INSTANCE_ID_LENGTH = 256;
/** `DataPointFlags.NO_RECORDED_VALUE_MASK`. */
const NO_RECORDED_VALUE = 1;
const MAX_INT8 = 2n ** 63n - 1n;

type RejectReason =
  | "missing time"
  | "time out of range"
  | "time more than a day in the future"
  | "missing start time"
  | "start time after time"
  | "missing value"
  | "value is not finite"
  | "unspecified temporality"
  | "invalid histogram buckets";

interface Context {
  latest: bigint;
  rejected: Map<RejectReason, number>;
  dropped: MetricDropCounts;
  total: number;
}

function reject(ctx: Context, reason: RejectReason): void {
  ctx.rejected.set(reason, (ctx.rejected.get(reason) ?? 0) + 1);
}

function resourceString(value: unknown, max: number): string | undefined {
  let s: string | undefined;
  if (typeof value === "string") s = value;
  else if (typeof value === "number" || typeof value === "boolean") {
    s = String(value);
  }
  if (s === undefined || s.trim() === "") return undefined;
  // `text` again: a cut can split a surrogate pair.
  return text(s.length > max ? s.slice(0, max) : s);
}

export function toIngestMetricBatch(
  request: ExportMetricsServiceRequest,
  nowUnixNano: bigint = BigInt(Date.now()) * 1_000_000n,
): IngestMetricBatch {
  const ctx: Context = {
    latest: nowUnixNano + MAX_FUTURE_NS,
    rejected: new Map(),
    dropped: {
      unsupportedType: 0,
      notStored: 0,
      typeMismatch: 0,
      noRecordedValue: 0,
    },
    total: 0,
  };
  const resourceMetrics: IngestResourceMetrics[] = [];

  for (const rm of request.resourceMetrics) {
    const resource = attributes(rm.resource?.attributes ?? []);
    const serviceName =
      resourceString(resource["service.name"], 16 * 1024) ?? UNKNOWN_SERVICE;
    const instanceId =
      resourceString(resource["service.instance.id"], MAX_INSTANCE_ID_LENGTH) ??
      "";
    const merged = new Map<string, IngestMetricPoint>();
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) mapMetric(metric, ctx, merged);
    }
    if (merged.size > 0) {
      resourceMetrics.push({
        serviceName,
        environment: environmentOf(resource),
        instanceId,
        points: [...merged.values()],
      });
    }
  }

  let rejectedDataPoints = 0;
  for (const n of ctx.rejected.values()) rejectedDataPoints += n;
  const batch: IngestMetricBatch = {
    resourceMetrics,
    rejectedDataPoints,
    dropped: ctx.dropped,
  };
  if (rejectedDataPoints > 0) {
    const reasons = [...ctx.rejected]
      .map(([reason, n]) => `${reason} (${n})`)
      .join(", ");
    batch.errorMessage = `Rejected ${rejectedDataPoints} of ${ctx.total} data points: ${reasons}.`;
  }
  return batch;
}

function pointCount(metric: Metric): number {
  const data = metric.data;
  return data.case === undefined ? 0 : data.value.dataPoints.length;
}

/** The catalog kind an OTLP metric maps to, or `undefined` for a type the receiver does not store. */
function kindOf(metric: Metric): CatalogKind | undefined {
  const data = metric.data;
  switch (data.case) {
    case "gauge":
      return "gauge";
    case "sum":
      if (data.value.isMonotonic) return "counter";
      // An UpDownCounter is a level when cumulative; a delta of a level is not stored.
      return data.value.aggregationTemporality === AggregationTemporality.DELTA
        ? undefined
        : "gauge";
    case "histogram":
      return "histogram";
    default:
      return undefined;
  }
}

function mapMetric(
  metric: Metric,
  ctx: Context,
  merged: Map<string, IngestMetricPoint>,
): void {
  const n = pointCount(metric);
  ctx.total += n;
  if (n === 0) return;
  const kind = kindOf(metric);
  if (kind === undefined) {
    ctx.dropped.unsupportedType += n;
    return;
  }
  const entry = catalogEntry(metric.name);
  if (entry === undefined) {
    ctx.dropped.notStored += n;
    return;
  }
  if (entry.kind !== kind || metric.unit !== entry.unit) {
    ctx.dropped.typeMismatch += n;
    return;
  }

  const data = metric.data;
  if (data.case === "gauge") {
    for (const p of data.value.dataPoints) {
      numberPoint(p, entry, "cumulative", ctx, merged);
    }
    return;
  }
  if (data.case === "sum" || data.case === "histogram") {
    const t = data.value.aggregationTemporality;
    if (
      t !== AggregationTemporality.DELTA &&
      t !== AggregationTemporality.CUMULATIVE
    ) {
      for (let i = 0; i < n; i++) reject(ctx, "unspecified temporality");
      return;
    }
    const temporality =
      t === AggregationTemporality.DELTA ? "delta" : "cumulative";
    if (data.case === "sum") {
      for (const p of data.value.dataPoints) {
        numberPoint(p, entry, temporality, ctx, merged);
      }
    } else {
      for (const p of data.value.dataPoints) {
        histogramPoint(p, entry, temporality, ctx, merged);
      }
    }
  }
}

/** Shared checks of a point's flags and times; `false` when it is dropped or rejected. */
function checkTimes(
  p: { flags: number; timeUnixNano: bigint; startTimeUnixNano: bigint },
  temporality: "cumulative" | "delta",
  ctx: Context,
): boolean {
  if ((p.flags & NO_RECORDED_VALUE) !== 0) {
    ctx.dropped.noRecordedValue++;
    return false;
  }
  const time = p.timeUnixNano;
  if (time === 0n) {
    reject(ctx, "missing time");
    return false;
  }
  if (time > MAX_INT8) {
    reject(ctx, "time out of range");
    return false;
  }
  if (time > ctx.latest) {
    reject(ctx, "time more than a day in the future");
    return false;
  }
  if (temporality === "delta" && p.startTimeUnixNano === 0n) {
    reject(ctx, "missing start time");
    return false;
  }
  if (p.startTimeUnixNano > time) {
    reject(ctx, "start time after time");
    return false;
  }
  return true;
}

function attributeText(value: AnyValue | undefined): string | undefined {
  const v = value?.value;
  switch (v?.case) {
    case "stringValue":
      return v.value;
    case "boolValue":
    case "intValue":
    case "doubleValue":
      return String(v.value);
    default:
      return undefined;
  }
}

/** The catalog's attribute keys only, as strings; and their canonical JSON. */
function keptAttributes(
  input: { key: string; value?: AnyValue }[],
  entry: CatalogEntry,
): { attributes: Record<string, string>; key: string } {
  const out: Record<string, string> = Object.create(null);
  if (entry.attributes.length > 0) {
    for (const kv of input) {
      if (!entry.attributes.includes(kv.key)) continue;
      const raw = attributeText(kv.value);
      if (raw === undefined) continue;
      out[kv.key] = text(
        raw.length > MAX_METRIC_ATTRIBUTE_LENGTH
          ? raw.slice(0, MAX_METRIC_ATTRIBUTE_LENGTH)
          : raw,
      );
    }
  }
  const keys = Object.keys(out).sort();
  return {
    attributes: out,
    key: JSON.stringify(keys.map((k) => [k, out[k]])),
  };
}

function numberValue(p: NumberDataPoint): number | undefined {
  const v = p.value;
  if (v.case === "asDouble") return v.value;
  if (v.case === "asInt") return Number(v.value);
  return undefined;
}

function numberPoint(
  p: NumberDataPoint,
  entry: CatalogEntry,
  temporality: "cumulative" | "delta",
  ctx: Context,
  merged: Map<string, IngestMetricPoint>,
): void {
  if (!checkTimes(p, temporality, ctx)) return;
  const value = numberValue(p);
  if (value === undefined) {
    reject(ctx, "missing value");
    return;
  }
  if (!Number.isFinite(value)) {
    reject(ctx, "value is not finite");
    return;
  }
  const { attributes: attrs, key } = keptAttributes(p.attributes, entry);
  const mergeKey = `${temporality}\u0000${key}\u0000${p.timeUnixNano}`;
  const fullKey = `${entry.name}\u0000${mergeKey}`;
  const existing = merged.get(fullKey);
  if (existing !== undefined) {
    existing.value =
      entry.kind === "gauge" && entry.merge === "max"
        ? Math.max(existing.value, value)
        : existing.value + value;
    existing.startTimeUnixNano = earlierStart(
      existing.startTimeUnixNano,
      p.startTimeUnixNano,
    );
    return;
  }
  merged.set(fullKey, {
    metric: entry.name,
    kind: entry.kind,
    temporality,
    attributes: attrs,
    attributesKey: key,
    timeUnixNano: p.timeUnixNano,
    startTimeUnixNano: p.startTimeUnixNano,
    value,
  });
}

/** The earlier of two start times, ignoring an unknown (0) one. */
function earlierStart(a: bigint, b: bigint): bigint {
  if (a === 0n) return b;
  if (b === 0n) return a;
  return a < b ? a : b;
}

function validBounds(bounds: number[]): boolean {
  if (bounds.length > MAX_HISTOGRAM_BOUNDS) return false;
  for (let i = 0; i < bounds.length; i++) {
    const b = bounds[i] as number;
    if (!Number.isFinite(b)) return false;
    if (i > 0 && b <= (bounds[i - 1] as number)) return false;
  }
  return true;
}

function histogramPoint(
  p: HistogramDataPoint,
  entry: CatalogEntry,
  temporality: "cumulative" | "delta",
  ctx: Context,
  merged: Map<string, IngestMetricPoint>,
): void {
  if (!checkTimes(p, temporality, ctx)) return;
  const bounds = p.explicitBounds;
  if (
    bounds.length === 0 ||
    !validBounds(bounds) ||
    p.bucketCounts.length !== bounds.length + 1
  ) {
    reject(ctx, "invalid histogram buckets");
    return;
  }
  const buckets = p.bucketCounts.map((c) => Number(c));
  // The bucket counts are what quantiles use, so the count is their sum.
  let count = 0;
  for (const c of buckets) count += c;
  if (!Number.isFinite(count)) {
    reject(ctx, "invalid histogram buckets");
    return;
  }
  const sum =
    p.sum !== undefined && Number.isFinite(p.sum) ? (p.sum as number) : null;
  const { attributes: attrs, key } = keptAttributes(p.attributes, entry);
  const fullKey = `${entry.name}\u0000${temporality}\u0000${key}\u0000${p.timeUnixNano}\u0000${bounds.join(",")}`;
  const existing = merged.get(fullKey);
  if (existing !== undefined) {
    const into = existing.bucketCounts as number[];
    for (let i = 0; i < into.length; i++)
      into[i] = (into[i] as number) + (buckets[i] as number);
    existing.count = (existing.count ?? 0) + count;
    existing.sum =
      existing.sum === null || sum === null ? null : (existing.sum ?? 0) + sum;
    existing.startTimeUnixNano = earlierStart(
      existing.startTimeUnixNano,
      p.startTimeUnixNano,
    );
    return;
  }
  merged.set(fullKey, {
    metric: entry.name,
    kind: "histogram",
    temporality,
    attributes: attrs,
    attributesKey: key,
    timeUnixNano: p.timeUnixNano,
    startTimeUnixNano: p.startTimeUnixNano,
    value: 0,
    count,
    sum,
    bounds: [...bounds],
    bucketCounts: buckets,
  });
}
