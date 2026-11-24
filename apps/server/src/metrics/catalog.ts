/**
 * Issue #18 (D-105): the metrics the optional receiver stores. Not a general metrics backend: a
 * metric whose name is not here is counted (`notStored`) and discarded, and so is a listed metric
 * sent with another instrument type or unit (`typeMismatch`), because the query's arithmetic depends
 * on both.
 *
 * The names are the runtime metrics `@nestrix-js/nestjs` itself records
 * (`packages/nestjs/src/metrics/runtime.ts`, `RUNTIME_METRIC_NAMES`) and its request-duration
 * histogram (`metrics/binding.ts`). Only the attribute keys listed for a metric are kept; points
 * that differ only in a dropped attribute are merged at ingest (`merge`): counters and histograms
 * are summed (a cumulative sum of cumulative series is the cumulative of their sum), levels by
 * `merge`. So `v8js.memory.heap.used` is stored as one series per instance (the sum over heap
 * spaces) and `http.server.request.duration` as one histogram per instance.
 *
 * Kinds, and what the query computes from them (`query/metrics.service.ts`):
 * - `counter`: a monotonic OTLP Sum, cumulative or delta. Queried as a rate per second.
 * - `gauge`: an OTLP Gauge, or a non-monotonic cumulative Sum (an UpDownCounter is a level).
 * - `histogram`: an OTLP Histogram with explicit buckets, cumulative or delta. Queried as quantiles.
 */

export type CatalogKind = "counter" | "gauge" | "histogram";

export interface CatalogEntry {
  readonly name: string;
  readonly kind: CatalogKind;
  /** The UCUM unit the sender must use (OTLP `Metric.unit`). */
  readonly unit: string;
  readonly description: string;
  /** Attribute keys kept; every other key is dropped before series are formed. */
  readonly attributes: readonly string[];
  /** How points that collapse into one series at ingest combine (levels only; others sum). */
  readonly merge: "sum" | "max";
}

export const METRIC_CATALOG: readonly CatalogEntry[] = Object.freeze([
  {
    name: "process.cpu.time",
    kind: "counter",
    unit: "s",
    description: "CPU time used by the process, by cpu.mode (user, system).",
    attributes: ["cpu.mode"],
    merge: "sum",
  },
  {
    name: "process.memory.usage",
    kind: "gauge",
    unit: "By",
    description: "Resident set size (RSS).",
    attributes: [],
    merge: "sum",
  },
  {
    name: "v8js.memory.heap.used",
    kind: "gauge",
    unit: "By",
    description: "V8 heap in use, summed over heap spaces.",
    attributes: [],
    merge: "sum",
  },
  {
    name: "v8js.memory.heap.space.size",
    kind: "gauge",
    unit: "By",
    description: "V8 heap committed, summed over heap spaces.",
    attributes: [],
    merge: "sum",
  },
  {
    name: "nodejs.eventloop.delay.p50",
    kind: "gauge",
    unit: "s",
    description: "Event loop delay, median over each export interval.",
    attributes: [],
    merge: "max",
  },
  {
    name: "nodejs.eventloop.delay.p99",
    kind: "gauge",
    unit: "s",
    description: "Event loop delay, 99th percentile over each export interval.",
    attributes: [],
    merge: "max",
  },
  {
    name: "nodejs.eventloop.delay.max",
    kind: "gauge",
    unit: "s",
    description: "Event loop delay, maximum over each export interval.",
    attributes: [],
    merge: "max",
  },
  {
    name: "http.server.request.duration",
    kind: "histogram",
    unit: "s",
    description: "Duration of HTTP server requests (all routes together).",
    attributes: [],
    merge: "sum",
  },
] satisfies CatalogEntry[]);

export const METRIC_NAMES: readonly string[] = Object.freeze(
  METRIC_CATALOG.map((e) => e.name),
);

const BY_NAME: ReadonlyMap<string, CatalogEntry> = new Map(
  METRIC_CATALOG.map((e) => [e.name, e]),
);

/** The entry for `name`; `undefined` for a metric that is not stored. Never reads `Object.prototype`. */
export function catalogEntry(name: string): CatalogEntry | undefined {
  return BY_NAME.get(name);
}

/** Explicit bounds per histogram point (more is a rejected point). */
export const MAX_HISTOGRAM_BOUNDS = 128;
/** A kept attribute value is cut to this many characters. */
export const MAX_METRIC_ATTRIBUTE_LENGTH = 128;

/**
 * Issue #87 (D-118): the bounds on an application metric (`NESTRIX_METRICS=all`), any name outside
 * the catalog. A name or unit over its length is not stored (`notStored`); an attribute whose key is
 * longer, whose value is not a string, bool or number, or past the first `MAX_APP_ATTRIBUTES` keys
 * (in sorted order) is dropped and counted (`droppedAttributes`); a longer value is cut.
 */
export const MAX_APP_METRIC_NAME_LENGTH = 255;
export const MAX_APP_METRIC_UNIT_LENGTH = 63;
export const MAX_APP_ATTRIBUTES = 16;
export const MAX_APP_ATTRIBUTE_KEY_LENGTH = 128;
export const MAX_APP_ATTRIBUTE_VALUE_LENGTH = 256;
