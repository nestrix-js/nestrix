/**
 * Historical runtime metrics of the standalone server (issue #18, D-105): `GET api/v1/metrics/catalog`
 * and `GET api/v1/metrics/series`. Types only: this file adds no runtime export.
 *
 * Optional and off by default (`NESTRIX_METRICS=on` on the server); `MetaResponse.metrics.available`
 * says whether they exist. Off, or on an embedded dashboard, both routes answer `404`. Only the
 * runtime metrics Nestrix records are stored (the catalog), per minute per series, for the server's
 * span retention.
 *
 * Arithmetic, per bucket of `stepMs`:
 * - `counter` (`process.cpu.time`): a rate per second. Per series, the increase between consecutive
 *   minutes (a lower value or a changed start time is a restart: the new value is the increase since
 *   it) divided by the time between them; the series of one instance (`cpu.mode`) are added.
 * - `gauge`: per instance the mean of its points in the bucket (`max`: their maximum, `min`: their
 *   minimum).
 * - across instances: `aggregation`, default `sum` for counters (total CPU of the service) and `avg`
 *   for gauges; `max` gives the busiest instance's value.
 * - `histogram`: bucket increases of every instance added, then `p50`, `p95` and `p99` by linear
 *   interpolation inside the bucket (an estimate within the bucket bounds).
 *
 * A bucket with no data is `null` (a gap): never interpolated, never zero.
 */

/** `MetaResponse.metrics`. */
export interface MetaMetrics {
  /** Whether `api/v1/metrics/*` exists: the standalone server with `NESTRIX_METRICS=on`. */
  available: boolean;
}

export type MetricKind = "counter" | "gauge" | "histogram";
export type MetricAggregation = "sum" | "avg" | "max" | "min";

export interface MetricDefinition {
  name: string;
  kind: MetricKind;
  /** The OTLP (UCUM) unit of the stored values: `s`, `By`. */
  unit: string;
  /** The unit of the values the series route returns: `s/s` for a counter of seconds (CPU seconds per second, 1 = one core). */
  valueUnit: string;
  description: string;
  /** `aggregation` when none is given. */
  defaultAggregation: MetricAggregation;
}

export interface MetricInstance {
  service: string;
  /** `deployment.environment.name` (issue #28, D-101); absent when the instance has none. */
  environment?: string;
  /** `service.instance.id`; `""` when the resource had none. */
  instanceId: string;
  firstSeenUnixMs: number;
  lastSeenUnixMs: number;
}

/** What the receiver kept and dropped since this server process started (not shared between instances). */
export interface MetricIngestStats {
  storedPoints: number;
  /** Points of series over `maxSeriesPerService` or `maxSeries`. */
  overSeriesCap: number;
  /** Points older than retention or more than two days ahead. */
  outOfRange: number;
  /** Invalid points (OTLP partial success). */
  rejectedPoints: number;
  /** Discarded by the catalog. */
  dropped: {
    unsupportedType: number;
    notStored: number;
    typeMismatch: number;
    noRecordedValue: number;
  };
  /** Series counted against the caps now. */
  activeSeries: number;
  maxSeriesPerService: number;
  maxSeries: number;
}

export interface MetricCatalogResponse {
  /** Days kept before today (`NESTRIX_RETENTION_DAYS`), as for spans. */
  retentionDays: number;
  /** Smallest `stepMs`: one minute. */
  minStepMs: number;
  metrics: MetricDefinition[];
  /** Services with metric data between `fromUnixMs` and `toUnixMs`, sorted. */
  services: string[];
  /** Instances with metric data in the range (of `service`, when given), most recently seen first, at most 200. */
  instances: MetricInstance[];
  instancesTruncated: boolean;
  ingest: MetricIngestStats;
}

export interface MetricSeries {
  /** `all instances`, an instance id (with `by=instance`), or `p50`/`p95`/`p99` for a histogram. */
  label: string;
  instanceId?: string;
  /** One value per `timestamps` entry, in `valueUnit`; `null` where there is no data. */
  values: (number | null)[];
}

export interface MetricSeriesResponse {
  metric: string;
  kind: MetricKind;
  unit: string;
  valueUnit: string;
  aggregation: MetricAggregation;
  stepMs: number;
  /** The range, `fromUnixMs` rounded down to a step. */
  fromUnixMs: number;
  toUnixMs: number;
  /** Bucket starts, Unix ms, oldest first. */
  timestamps: number[];
  series: MetricSeries[];
  /** Instances that contributed to any bucket, sorted. */
  instances: string[];
}
