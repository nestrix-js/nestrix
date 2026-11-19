// The standalone server's stored metrics (issue #18): `GET api/v1/metrics/catalog` and
// `GET api/v1/metrics/series`, as the dashboard reads them. The numbers are made up but follow
// the real arithmetic's shapes: a gap is `null`, CPU is seconds per second, memory is bytes.
import type {
  MetricCatalogResponse,
  MetricDefinition,
  MetricInstance,
  MetricSeriesResponse,
} from "@nestrix-js/protocol";

const MIN = 60_000;

export const METRIC_DEFINITIONS: MetricDefinition[] = [
  {
    name: "process.cpu.time",
    kind: "counter",
    unit: "s",
    valueUnit: "s/s",
    description: "CPU time used by the process",
    defaultAggregation: "sum",
  },
  {
    name: "process.memory.usage",
    kind: "gauge",
    unit: "By",
    valueUnit: "By",
    description: "Resident set size",
    defaultAggregation: "avg",
  },
  {
    name: "v8js.memory.heap.used",
    kind: "gauge",
    unit: "By",
    valueUnit: "By",
    description: "V8 heap in use",
    defaultAggregation: "avg",
  },
  {
    name: "nodejs.eventloop.delay.p99",
    kind: "gauge",
    unit: "s",
    valueUnit: "s",
    description: "Event-loop delay, 99th percentile",
    defaultAggregation: "avg",
  },
  {
    // Every point is missing: the panel shows its empty state.
    name: "nodejs.eventloop.delay.max",
    kind: "gauge",
    unit: "s",
    valueUnit: "s",
    description: "Event-loop delay, maximum",
    defaultAggregation: "avg",
  },
];

/** What the mock holds; tests replace it. */
export interface MetricsFixture {
  /** Services with data. */
  service: string;
  instances: string[];
  /** Points over the receiver's series limit. */
  overSeriesCap: number;
  /** Nothing stored at all. */
  empty: boolean;
}

export const defaultMetrics = (): MetricsFixture => ({
  service: "orders",
  instances: ["pod-a", "pod-b"],
  overSeriesCap: 0,
  empty: false,
});

const num = (q: URLSearchParams, key: string, fallback: number) => {
  const raw = q.get(key);
  return raw === null ? fallback : Number(raw);
};

export function catalogAnswer(
  q: URLSearchParams,
  fixture: MetricsFixture,
): MetricCatalogResponse {
  const to = num(q, "toUnixMs", Date.now());
  const wanted = q.get("service");
  const listed = wanted === null || wanted === fixture.service;
  const instances: MetricInstance[] =
    fixture.empty || !listed
      ? []
      : fixture.instances.map((instanceId) => ({
          service: fixture.service,
          instanceId,
          firstSeenUnixMs: to - 3_600_000,
          lastSeenUnixMs: to - MIN,
        }));
  return {
    retentionDays: 7,
    minStepMs: MIN,
    metrics: METRIC_DEFINITIONS,
    services: fixture.empty ? [] : [fixture.service],
    instances,
    instancesTruncated: false,
    ingest: {
      storedPoints: fixture.empty ? 0 : 5000,
      overSeriesCap: fixture.overSeriesCap,
      outOfRange: 0,
      rejectedPoints: 0,
      dropped: {
        unsupportedType: 0,
        notStored: 0,
        typeMismatch: 0,
        noRecordedValue: 0,
      },
      activeSeries: fixture.instances.length * 8,
      maxSeriesPerService: 2000,
      maxSeries: 20000,
    },
  };
}

/** A value for bucket `i` of one instance. A gap (index 10 to 12) in the memory series. */
function valueAt(
  name: string,
  i: number,
  instanceIndex: number,
): number | null {
  const wobble = Math.sin(i / 4 + instanceIndex);
  switch (name) {
    case "process.cpu.time":
      return 0.3 + 0.1 * wobble + instanceIndex * 0.05;
    case "process.memory.usage":
      return i >= 10 && i <= 12
        ? null
        : 200_000_000 + 20_000_000 * wobble + instanceIndex * 10_000_000;
    case "v8js.memory.heap.used":
      return 80_000_000 + 5_000_000 * wobble;
    case "nodejs.eventloop.delay.p99":
      return 0.004 + 0.002 * (wobble + 1);
    default:
      return null;
  }
}

export function seriesAnswer(
  q: URLSearchParams,
  fixture: MetricsFixture,
): { status: number; body: unknown } {
  const name = q.get("metric") ?? "";
  const definition = METRIC_DEFINITIONS.find((d) => d.name === name);
  if (definition === undefined) {
    return {
      status: 400,
      body: { error: { code: "bad_request", message: "Unknown metric" } },
    };
  }
  const to = num(q, "toUnixMs", Date.now());
  const from = num(q, "fromUnixMs", to - 60 * MIN);
  const stepMs =
    q.get("stepMs") === null
      ? Math.max(1, Math.ceil((to - from) / MIN / 360)) * MIN
      : Number(q.get("stepMs"));
  const start = Math.floor(from / stepMs) * stepMs;
  const count = Math.ceil((to - start) / stepMs);
  const timestamps = Array.from(
    { length: count },
    (_, i) => start + i * stepMs,
  );
  const wantedInstance = q.get("instance");
  const pool = fixture.empty
    ? []
    : wantedInstance === null
      ? fixture.instances
      : fixture.instances.filter((x) => x === wantedInstance);
  const aggregation =
    (q.get("aggregation") as MetricSeriesResponse["aggregation"] | null) ??
    definition.defaultAggregation;
  const column = (instanceIndex: number) =>
    timestamps.map((_, i) => valueAt(name, i, instanceIndex));
  let series: MetricSeriesResponse["series"];
  if (pool.length === 0) {
    series = [{ label: "all instances", values: timestamps.map(() => null) }];
  } else if (q.get("by") === "instance") {
    series = pool.slice(0, 20).map((instanceId) => ({
      label: instanceId,
      instanceId,
      values: column(fixture.instances.indexOf(instanceId)),
    }));
  } else {
    const columns = pool.map((id) => column(fixture.instances.indexOf(id)));
    const combine = (values: number[]): number => {
      if (aggregation === "max") return Math.max(...values);
      if (aggregation === "min") return Math.min(...values);
      const sum = values.reduce((a, b) => a + b, 0);
      return aggregation === "sum" ? sum : sum / values.length;
    };
    series = [
      {
        label: "all instances",
        values: timestamps.map((_, i) => {
          const present = columns
            .map((c) => c[i])
            .filter((v): v is number => v !== null && v !== undefined);
          return present.length === 0 ? null : combine(present);
        }),
      },
    ];
  }
  return {
    status: 200,
    body: {
      metric: name,
      kind: definition.kind,
      unit: definition.unit,
      valueUnit: definition.valueUnit,
      aggregation,
      stepMs,
      fromUnixMs: start,
      toUnixMs: to,
      timestamps,
      series,
      instances: [...pool].sort(),
    } satisfies MetricSeriesResponse,
  };
}
