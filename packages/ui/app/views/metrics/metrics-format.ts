// Pure logic of the Metrics page (issue #18, D-105): what to draw from a series response, in which
// unit, and where a click on a chart leads. No React.
import type {
  MetricAggregation,
  MetricDefinition,
  MetricSeriesResponse,
} from "@nestrix-js/protocol";

import type { ChartSeries } from "@/components/kit/line-chart";
import { formatDuration } from "@/lib/format";
import { formatMemoryAxis } from "@/views/runtime/runtime-format";

const MINUTE_MS = 60_000;
/** The server answers at most this many series for `by=instance`. */
export const MAX_INSTANCE_SERIES = 20;
/** Data that ended this long (and at least two steps) before the range's end is called stale. */
const STALE_AFTER_MS = 5 * MINUTE_MS;

/** The panels' order: what a latency or error spike is usually read against first. */
const PREFERRED_ORDER = [
  "process.cpu.time",
  "process.memory.usage",
  "v8js.memory.heap.used",
  "v8js.memory.heap.space.size",
  "nodejs.eventloop.delay.p99",
  "nodejs.eventloop.delay.p50",
  "nodejs.eventloop.delay.max",
  "http.server.request.duration",
];

const TITLES: Record<string, string> = {
  "process.cpu.time": "CPU",
  "process.memory.usage": "Memory (RSS)",
  "v8js.memory.heap.used": "Heap used",
  "v8js.memory.heap.space.size": "Heap size",
  "nodejs.eventloop.delay.p50": "Event-loop delay p50",
  "nodejs.eventloop.delay.p99": "Event-loop delay p99",
  "nodejs.eventloop.delay.max": "Event-loop delay max",
  "http.server.request.duration": "Request duration",
};

export const metricTitle = (name: string): string => TITLES[name] ?? name;

/** The catalog's metrics, the well-known ones first in a fixed order, the rest by name. */
export function orderMetrics(metrics: MetricDefinition[]): MetricDefinition[] {
  const rank = (name: string) => {
    const i = PREFERRED_ORDER.indexOf(name);
    return i === -1 ? PREFERRED_ORDER.length : i;
  };
  return [...metrics].sort(
    (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name),
  );
}

/**
 * Formats a value in the unit the series route returns (`valueUnit`): bytes as memory, seconds as a
 * duration, `s/s` (CPU seconds per second) as a share of one core, a ratio (`1`) as a percentage.
 * Any other unit is shown as the number and the unit.
 */
export function valueFormatter(valueUnit: string): (value: number) => string {
  switch (valueUnit) {
    case "By":
      return formatMemoryAxis;
    case "s":
      return (v) => formatDuration(v * 1000);
    case "s/s":
      return (v) => formatShare(v);
    case "1":
      return (v) => formatShare(v);
    default:
      return (v) =>
        Number.isFinite(v)
          ? `${Number(v.toPrecision(3))} ${valueUnit}`.trim()
          : "-";
  }
}

/** 0.4 as "40%", 1.5 as "150%"; one decimal below 10%. */
export function formatShare(fraction: number): string {
  if (!Number.isFinite(fraction)) return "-";
  const percent = fraction * 100;
  return `${percent < 10 ? percent.toFixed(1) : percent.toFixed(0)}%`;
}

/** The unit in words, for the panel's description. */
export function unitLabel(valueUnit: string): string {
  switch (valueUnit) {
    case "By":
      return "bytes";
    case "s":
      return "seconds";
    case "s/s":
      return "share of one core (100% = one core)";
    case "1":
      return "ratio";
    default:
      return valueUnit;
  }
}

/** The smallest y axis maximum for a unit, so small values are not drawn flat. */
export function axisFloor(valueUnit: string): number {
  switch (valueUnit) {
    case "By":
      return 1;
    case "s":
      return 0.001;
    default:
      return 0.1;
  }
}

/** Histograms are always percentiles of every instance together: no aggregation, no split. */
export const HISTOGRAM_NOTE = "percentiles are computed over all instances";

export const AGGREGATIONS: readonly {
  value: MetricAggregation;
  label: string;
}[] = [
  { value: "sum", label: "Sum of instances" },
  { value: "avg", label: "Average of instances" },
  { value: "max", label: "Busiest instance (max)" },
  { value: "min", label: "Quietest instance (min)" },
];

/** What one line is, in words: how the instances were combined, or that they are shown apart. */
export function aggregationLabel(
  kind: MetricSeriesResponse["kind"],
  aggregation: MetricAggregation,
  splitByInstance: boolean,
  instance: string | undefined,
): string {
  if (instance !== undefined) return `instance ${instance}`;
  if (kind === "histogram") return HISTOGRAM_NOTE;
  if (splitByInstance) return "one line per instance";
  return (
    AGGREGATIONS.find((a) => a.value === aggregation)?.label.toLowerCase() ??
    aggregation
  );
}

export interface ShapedSeries {
  /** Unix seconds, for the chart. */
  xs: number[];
  series: ChartSeries[];
  /** Whether any bucket of any series holds a value. */
  hasData: boolean;
  /** Buckets without data between the first and the last that has some (drawn as gaps). */
  gapBuckets: number;
  /** Minutes since the last bucket with data, when that is long ago; otherwise null. */
  staleMinutes: number | null;
  /** The series cut at 20 instances: how many instances there are, when more. */
  cappedAt: { shown: number; total: number } | null;
}

const COLORS = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
];

/** Columns for a chart from a series response; `null` stays `null` so the line breaks. */
export function shapeSeries(response: MetricSeriesResponse): ShapedSeries {
  const xs = response.timestamps.map((t) => t / 1000);
  const series: ChartSeries[] = response.series.map((s, i) => ({
    label: s.label,
    color: COLORS[i % COLORS.length] as string,
    values: s.values.map((v) => (v === null || !Number.isFinite(v) ? null : v)),
  }));
  const present = response.timestamps.map((_, i) =>
    series.some((s) => s.values[i] !== null && s.values[i] !== undefined),
  );
  const first = present.indexOf(true);
  const last = present.lastIndexOf(true);
  const hasData = first !== -1;
  const gapBuckets = hasData
    ? present.slice(first, last + 1).filter((p) => !p).length
    : 0;
  let staleMinutes: number | null = null;
  if (hasData) {
    const lastEnd = (response.timestamps[last] as number) + response.stepMs;
    const behind = response.toUnixMs - lastEnd;
    if (behind >= Math.max(STALE_AFTER_MS, 2 * response.stepMs)) {
      staleMinutes = Math.round(behind / MINUTE_MS);
    }
  }
  const cappedAt =
    response.series.length >= MAX_INSTANCE_SERIES &&
    response.instances.length > response.series.length
      ? { shown: response.series.length, total: response.instances.length }
      : null;
  return { xs, series, hasData, gapBuckets, staleMinutes, cappedAt };
}

/** The range of the buckets a click or drag covers; a click (`fromMs === toMs`) is one bucket. */
export function selectedRange(
  fromSeconds: number,
  toSeconds: number,
  timestamps: readonly number[],
  stepMs: number,
): { fromUnixMs: number; toUnixMs: number } | null {
  const first = timestamps[0];
  if (first === undefined || stepMs <= 0) return null;
  const index = (ms: number) =>
    Math.min(
      timestamps.length - 1,
      Math.max(0, Math.floor((ms - first) / stepMs)),
    );
  const lo = index(Math.min(fromSeconds, toSeconds) * 1000);
  const hi = index(Math.max(fromSeconds, toSeconds) * 1000);
  return {
    fromUnixMs: first + lo * stepMs,
    toUnixMs: first + (hi + 1) * stepMs - 1,
  };
}

interface Scope {
  service?: string | undefined;
  environment?: string | undefined;
}

function hashPath(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  const text = q.toString();
  return text === "" ? path : `${path}?${text}`;
}

/** The request list for a time range, in the same service and environment. */
export function requestsHref(
  scope: Scope,
  range: { fromUnixMs: number; toUnixMs: number },
): string {
  return hashPath("/requests", {
    service: scope.service,
    environment: scope.environment,
    fromUnixMs: range.fromUnixMs,
    toUnixMs: range.toUnixMs,
  });
}

/** Metrics around a trace: a margin on both sides of it, in the trace's service. */
export const TRACE_METRICS_MARGIN_MS = 15 * MINUTE_MS;
export function metricsHrefAroundTrace(
  scope: Scope,
  trace: { startMs: number; durationMs: number },
): string {
  return hashPath("/metrics", {
    service: scope.service,
    environment: scope.environment,
    fromUnixMs: Math.floor(trace.startMs - TRACE_METRICS_MARGIN_MS),
    toUnixMs: Math.ceil(
      trace.startMs + trace.durationMs + TRACE_METRICS_MARGIN_MS,
    ),
  });
}

const PAIR_SEPARATOR = "\u001f";

/** One option value for the instance select: the pair, so equal ids in two services stay apart. */
export const encodeInstance = (service: string, instanceId: string): string =>
  `${service}${PAIR_SEPARATOR}${instanceId}`;

export function decodeInstance(
  value: string,
): { service: string; instanceId: string } | null {
  const at = value.indexOf(PAIR_SEPARATOR);
  return at === -1
    ? null
    : { service: value.slice(0, at), instanceId: value.slice(at + 1) };
}

/**
 * The instance the URL names, when the catalog lists it (in the chosen service, when one is
 * chosen). The returned pair is what the series request sends: `instance` always with its `service`.
 */
export function resolveInstance(
  instances: readonly { service: string; instanceId: string }[],
  instance: string | null,
  instanceService: string | null,
  selectedService: string | undefined,
): { service: string; instanceId: string } | undefined {
  if (instance === null) return undefined;
  return instances.find(
    (i) =>
      i.instanceId === instance &&
      (instanceService === null || i.service === instanceService) &&
      (selectedService === undefined || i.service === selectedService),
  );
}
