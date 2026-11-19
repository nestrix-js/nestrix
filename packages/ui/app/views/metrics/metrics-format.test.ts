import type {
  MetricDefinition,
  MetricSeriesResponse,
} from "@nestrix-js/protocol";
import { describe, expect, it } from "vitest";

import {
  aggregationLabel,
  axisFloor,
  decodeInstance,
  encodeInstance,
  formatShare,
  metricsHrefAroundTrace,
  metricTitle,
  orderMetrics,
  requestsHref,
  resolveInstance,
  selectedRange,
  shapeSeries,
  unitLabel,
  valueFormatter,
} from "@/views/metrics/metrics-format";

const MIN = 60_000;
const T0 = 1_794_400_000_000 - (1_794_400_000_000 % MIN);

function response(
  overrides: Partial<MetricSeriesResponse> = {},
): MetricSeriesResponse {
  return {
    metric: "process.memory.usage",
    kind: "gauge",
    unit: "By",
    valueUnit: "By",
    aggregation: "avg",
    stepMs: MIN,
    fromUnixMs: T0,
    toUnixMs: T0 + 6 * MIN,
    timestamps: [0, 1, 2, 3, 4, 5].map((i) => T0 + i * MIN),
    series: [
      {
        label: "all instances",
        values: [1e8, 1.1e8, null, null, 1.2e8, 1.3e8],
      },
    ],
    instances: ["a", "b"],
    ...overrides,
  };
}

describe("units", () => {
  it("formats bytes as memory, seconds as a duration, CPU seconds per second as a share of a core", () => {
    expect(valueFormatter("By")(512_000_000)).toBe("512 MB");
    expect(valueFormatter("By")(1_500_000)).toBe("1.5 MB");
    expect(valueFormatter("s")(0.0025)).toBe("2.5 ms");
    expect(valueFormatter("s")(1.5)).toBe("1.50 s");
    expect(valueFormatter("s/s")(0.042)).toBe("4.2%");
    expect(valueFormatter("s/s")(1.5)).toBe("150%");
    expect(valueFormatter("1")(0.5)).toBe("50%");
  });

  it("shows an unknown unit as the number and the unit, and never throws on a bad number", () => {
    expect(valueFormatter("{request}")(12.3456)).toBe("12.3 {request}");
    expect(valueFormatter("{request}")(Number.NaN)).toBe("-");
    expect(formatShare(Number.POSITIVE_INFINITY)).toBe("-");
  });

  it("describes the unit and gives small units a small axis floor", () => {
    expect(unitLabel("By")).toBe("bytes");
    expect(unitLabel("s")).toBe("seconds");
    expect(unitLabel("s/s")).toContain("one core");
    expect(unitLabel("1")).toBe("ratio");
    expect(axisFloor("By")).toBe(1);
    expect(axisFloor("s")).toBeLessThan(0.01);
    expect(axisFloor("s/s")).toBeLessThan(1);
  });
});

describe("panel order and titles", () => {
  const defs = (names: string[]) =>
    names.map((name) => ({ name }) as MetricDefinition);
  it("puts CPU, memory, heap and event-loop first, then the rest by name", () => {
    expect(
      orderMetrics(
        defs([
          "zeta.metric",
          "nodejs.eventloop.delay.p99",
          "alpha.metric",
          "process.cpu.time",
          "v8js.memory.heap.used",
          "process.memory.usage",
        ]),
      ).map((d) => d.name),
    ).toEqual([
      "process.cpu.time",
      "process.memory.usage",
      "v8js.memory.heap.used",
      "nodejs.eventloop.delay.p99",
      "alpha.metric",
      "zeta.metric",
    ]);
  });
  it("titles a known metric and falls back to the catalog name", () => {
    expect(metricTitle("process.cpu.time")).toBe("CPU");
    expect(metricTitle("custom.thing")).toBe("custom.thing");
  });
});

describe("aggregation labels", () => {
  it("says how replicas were combined", () => {
    expect(aggregationLabel("gauge", "avg", false, undefined)).toBe(
      "average of instances",
    );
    expect(aggregationLabel("counter", "sum", false, undefined)).toBe(
      "sum of instances",
    );
    expect(aggregationLabel("gauge", "max", false, undefined)).toBe(
      "busiest instance (max)",
    );
    expect(aggregationLabel("gauge", "avg", true, undefined)).toBe(
      "one line per instance",
    );
    expect(aggregationLabel("gauge", "avg", false, "pod-1")).toBe(
      "instance pod-1",
    );
    expect(aggregationLabel("histogram", "sum", true, undefined)).toBe(
      "percentiles are computed over all instances",
    );
  });
});

describe("shapeSeries", () => {
  it("keeps null as a gap, counts the gap, and converts time to seconds", () => {
    const shaped = shapeSeries(response());
    expect(shaped.xs[0]).toBe(T0 / 1000);
    expect(shaped.series[0]?.values).toEqual([
      1e8,
      1.1e8,
      null,
      null,
      1.2e8,
      1.3e8,
    ]);
    expect(shaped.hasData).toBe(true);
    expect(shaped.gapBuckets).toBe(2);
    expect(shaped.staleMinutes).toBeNull();
    expect(shaped.cappedAt).toBeNull();
  });

  it("is empty when every value is null, and a non-finite number is a gap too", () => {
    const none = shapeSeries(
      response({ series: [{ label: "x", values: Array(6).fill(null) }] }),
    );
    expect(none.hasData).toBe(false);
    expect(none.gapBuckets).toBe(0);
    const bad = shapeSeries(
      response({
        series: [{ label: "x", values: [1, Number.NaN, 3, null, null, null] }],
      }),
    );
    expect(bad.series[0]?.values).toEqual([1, null, 3, null, null, null]);
    expect(bad.gapBuckets).toBe(1);
  });

  it("counts a bucket as present when any line has a value", () => {
    const shaped = shapeSeries(
      response({
        series: [
          { label: "a", values: [1, null, null, 1, 1, 1] },
          { label: "b", values: [null, 2, null, null, null, null] },
        ],
      }),
    );
    expect(shaped.gapBuckets).toBe(1);
  });

  it("calls data stale when it ended long before the end of the range", () => {
    const shaped = shapeSeries(
      response({
        timestamps: Array.from({ length: 30 }, (_, i) => T0 + i * MIN),
        toUnixMs: T0 + 30 * MIN,
        series: [
          {
            label: "x",
            values: Array.from({ length: 30 }, (_, i) => (i < 10 ? 1 : null)),
          },
        ],
      }),
    );
    expect(shaped.staleMinutes).toBe(20);
    expect(shaped.gapBuckets).toBe(0);
    // Four minutes behind is just the usual export delay.
    const fresh = shapeSeries(
      response({ series: [{ label: "x", values: [1, 1, 1, 1, 1, null] }] }),
    );
    expect(fresh.staleMinutes).toBeNull();
  });

  it("notes when the instance lines were cut at 20", () => {
    const series = Array.from({ length: 20 }, (_, i) => ({
      label: `i${i}`,
      instanceId: `i${i}`,
      values: [1, 1, 1, 1, 1, 1],
    }));
    const capped = shapeSeries(
      response({
        series,
        instances: Array.from({ length: 27 }, (_, i) => `i${i}`),
      }),
    );
    expect(capped.cappedAt).toEqual({ shown: 20, total: 27 });
    expect(capped.series).toHaveLength(20);
    // The colours repeat after five lines.
    expect(capped.series[5]?.color).toBe(capped.series[0]?.color);
    expect(
      shapeSeries(
        response({
          series,
          instances: Array.from({ length: 20 }, (_, i) => `i${i}`),
        }),
      ).cappedAt,
    ).toBeNull();
  });
});

describe("selectedRange and links", () => {
  const timestamps = [0, 1, 2, 3, 4, 5].map((i) => T0 + i * MIN);
  it("turns a click into the bucket under it", () => {
    const at = (T0 + 2 * MIN + 20_000) / 1000;
    expect(selectedRange(at, at, timestamps, MIN)).toEqual({
      fromUnixMs: T0 + 2 * MIN,
      toUnixMs: T0 + 3 * MIN - 1,
    });
  });
  it("turns a drag into the buckets it covers, in either direction, clamped to the chart", () => {
    expect(
      selectedRange(
        (T0 + 4 * MIN + 1000) / 1000,
        (T0 + 1 * MIN + 1000) / 1000,
        timestamps,
        MIN,
      ),
    ).toEqual({ fromUnixMs: T0 + MIN, toUnixMs: T0 + 5 * MIN - 1 });
    expect(selectedRange(0, 9_999_999_999, timestamps, MIN)).toEqual({
      fromUnixMs: T0,
      toUnixMs: T0 + 6 * MIN - 1,
    });
  });
  it("has no range without buckets", () => {
    expect(selectedRange(1, 2, [], MIN)).toBeNull();
  });

  it("builds the request list link with service, environment and the same time range", () => {
    expect(
      requestsHref(
        { service: "shop", environment: "production" },
        { fromUnixMs: 1000, toUnixMs: 2999 },
      ),
    ).toBe(
      "/requests?service=shop&environment=production&fromUnixMs=1000&toUnixMs=2999",
    );
    expect(requestsHref({}, { fromUnixMs: 1, toUnixMs: 2 })).toBe(
      "/requests?fromUnixMs=1&toUnixMs=2",
    );
  });

  it("builds the metrics link around a trace with 15 minutes either side", () => {
    expect(
      metricsHrefAroundTrace(
        { service: "shop", environment: "staging" },
        { startMs: 10 * MIN, durationMs: 2500 },
      ),
    ).toBe(
      `/metrics?service=shop&environment=staging&fromUnixMs=${-5 * MIN}&toUnixMs=${25 * MIN + 2500}`,
    );
  });
});

describe("instance choice", () => {
  const listed = [
    { service: "orders", instanceId: "pod-a" },
    { service: "billing", instanceId: "pod-a" },
    { service: "billing", instanceId: "pod-b" },
  ];
  it("round-trips the service and instance pair", () => {
    expect(decodeInstance(encodeInstance("billing", "pod-a"))).toEqual({
      service: "billing",
      instanceId: "pod-a",
    });
    expect(decodeInstance("")).toBeNull();
  });
  it("keeps equal ids of two services apart", () => {
    expect(resolveInstance(listed, "pod-a", "billing", undefined)).toEqual({
      service: "billing",
      instanceId: "pod-a",
    });
    expect(resolveInstance(listed, "pod-a", "orders", undefined)?.service).toBe(
      "orders",
    );
  });
  it("only accepts an instance of the selected service, and an unknown one is none", () => {
    expect(resolveInstance(listed, "pod-b", null, "orders")).toBeUndefined();
    expect(resolveInstance(listed, "pod-b", null, "billing")?.service).toBe(
      "billing",
    );
    expect(resolveInstance(listed, "pod-z", null, undefined)).toBeUndefined();
    expect(resolveInstance(listed, null, null, undefined)).toBeUndefined();
  });
});
