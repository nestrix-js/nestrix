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
    name: "http.server.request.duration",
    kind: "histogram",
    unit: "s",
    valueUnit: "s",
    description: "Request duration",
    defaultAggregation: "sum",
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
  /** The service with data. */
  service: string;
  instances: string[];
  /** A second service that reuses these instance ids. */
  otherService?: string;
  /** Points over the receiver's series limit. */
  overSeriesCap: number;
  /** Nothing stored at all. */
  empty: boolean;
  /** Issue #87 (D-118): application metrics (`NESTRIX_METRICS=all`); none by default. */
  appMetrics?: MetricDefinition[];
}

/** Application metrics of the kind `NESTRIX_METRICS=all` lists (D-118). */
export function appMetricDefinitions(extra = 0): MetricDefinition[] {
  const base = (
    name: string,
    kind: MetricDefinition["kind"],
    unit: string,
    attributeKeys: string[],
  ): MetricDefinition => ({
    name,
    kind,
    unit,
    valueUnit: kind === "counter" ? `${unit}/s` : unit,
    description: "",
    defaultAggregation: kind === "counter" ? "sum" : "avg",
    app: true,
    attributeKeys,
  });
  return [
    base("db.client.connection.wait_time", "histogram", "s", ["pool"]),
    base("orders.created", "counter", "{order}", ["channel"]),
    base("queue.depth", "gauge", "{job}", ["queue"]),
    ...Array.from({ length: extra }, (_, i) =>
      base(`jobs.batch${String(i).padStart(2, "0")}.size`, "gauge", "1", []),
    ),
  ];
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
  const listed = true;
  const services = [fixture.service, fixture.otherService].filter(
    (x): x is string => x !== undefined && (wanted === null || wanted === x),
  );
  const instances: MetricInstance[] =
    fixture.empty || !listed
      ? []
      : services.flatMap((service) =>
          fixture.instances.map((instanceId) => ({
            service,
            instanceId,
            firstSeenUnixMs: to - 3_600_000,
            lastSeenUnixMs: to - MIN,
          })),
        );
  return {
    retentionDays: 7,
    minStepMs: MIN,
    metrics: [...METRIC_DEFINITIONS, ...(fixture.appMetrics ?? [])],
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
  const definition = [
    ...METRIC_DEFINITIONS,
    ...(fixture.appMetrics ?? []),
  ].find((d) => d.name === name);
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
  if (definition.kind === "histogram") {
    // Percentiles over every instance together: `aggregation` and `by` do not apply.
    const quantiles: [string, number][] = [
      ["p50", 0.02],
      ["p95", 0.08],
      ["p99", 0.2],
    ];
    return {
      status: 200,
      body: {
        metric: name,
        kind: definition.kind,
        unit: definition.unit,
        valueUnit: definition.valueUnit,
        aggregation: definition.defaultAggregation,
        stepMs,
        fromUnixMs: start,
        toUnixMs: to,
        timestamps,
        series: quantiles.map(([label, base]) => ({
          label,
          values: timestamps.map(() => (pool.length === 0 ? null : base)),
        })),
        instances: [...pool].sort(),
      } satisfies MetricSeriesResponse,
    };
  }
  const column = (instanceIndex: number) =>
    timestamps.map((_, i) =>
      definition.app
        ? 5 + Math.sin(i / 4 + instanceIndex)
        : valueAt(name, i, instanceIndex),
    );
  const by = q.get("by");
  let series: MetricSeriesResponse["series"];
  if (pool.length === 0) {
    series = [{ label: "all instances", values: timestamps.map(() => null) }];
  } else if (by?.startsWith("attr.")) {
    // D-118: one series per value of the attribute.
    series = ["first", "second"].map((group, k) => ({
      label: group,
      group,
      values: column(k),
    }));
  } else if (by === "instance") {
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
      ...(by?.startsWith("attr.") ? { by, groupCount: 2 } : {}),
    } satisfies MetricSeriesResponse,
  };
}
