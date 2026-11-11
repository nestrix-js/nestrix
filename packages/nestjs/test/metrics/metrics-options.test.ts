// No global state. P6-02: resolution of the `metrics` option and the metric export destination.
import { describe, expect, it } from "vitest";
import type { NestrixModuleOptions } from "../../src/options.js";
import {
  DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS,
  type ResolvedMetricExport,
  type ResolvedMetrics,
  resolveMetrics,
  resolveOptions,
} from "../../src/resolve-options.js";

/** The export destination, or `undefined` when metrics or their export are off. */
function destination(
  m: ResolvedMetrics | false,
): ResolvedMetricExport | undefined {
  if (m === false || m.export === false) return undefined;
  return m.export;
}

describe("metrics option", () => {
  it("defaults to on, runtime on, no export without an endpoint", () => {
    expect(resolveOptions({}, {}).metrics).toEqual({
      runtime: true,
      export: false,
    });
  });

  it("false turns metrics off; runtime: false keeps the histogram", () => {
    expect(resolveOptions({ metrics: false }, {}).metrics).toBe(false);
    expect(resolveOptions({ metrics: { runtime: false } }, {}).metrics).toEqual(
      { runtime: false, export: false },
    );
  });

  it.each([
    [true, "metrics must be false or an object"],
    [null, "metrics must be false or an object"],
    ["on", "metrics must be false or an object"],
    [{ runtime: "yes" }, "metrics.runtime must be a boolean"],
  ])("rejects %j at forRoot time", (value, message) => {
    expect(() =>
      resolveOptions({ metrics: value } as unknown as NestrixModuleOptions, {}),
    ).toThrow(`Invalid Nestrix options: ${message}`);
  });

  it("is frozen", () => {
    const m = resolveOptions(
      { export: { otlp: { endpoint: "http://c:4318" } } },
      {},
    ).metrics;
    expect(Object.isFrozen(m)).toBe(true);
    expect(m && Object.isFrozen(m.export)).toBe(true);
  });
});

describe("metric export destination", () => {
  const opts = (endpoint?: string): NestrixModuleOptions =>
    endpoint ? { export: { otlp: { endpoint } } } : {};

  it("appends /v1/metrics to the option endpoint, which wins over the metrics variable", () => {
    const m = resolveMetrics(opts("http://c:4318/"), {
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://env/m",
    });
    expect(destination(m)?.url).toBe("http://c:4318/v1/metrics");
  });

  it("uses OTEL_EXPORTER_OTLP_METRICS_ENDPOINT as given, over the generic variable", () => {
    const m = resolveMetrics(opts(), {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://generic:4318",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://env/custom",
    });
    expect(destination(m)?.url).toBe("http://env/custom");
  });

  it("appends /v1/metrics to OTEL_EXPORTER_OTLP_ENDPOINT", () => {
    const m = resolveMetrics(opts(), {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://generic:4318",
    });
    expect(destination(m)?.url).toBe("http://generic:4318/v1/metrics");
  });

  it("a traces-only endpoint implies no metrics URL", () => {
    const m = resolveMetrics(opts(), {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://t:4318/v1/traces",
    });
    expect(destination(m)).toBeUndefined();
  });

  it("needs trace export on: otlp: false, or no traces endpoint, exports no metrics", () => {
    expect(
      resolveMetrics(
        { export: { otlp: false } },
        { OTEL_EXPORTER_OTLP_ENDPOINT: "http://generic:4318" },
      ),
    ).toEqual({ runtime: true, export: false });
    // A metrics variable alone does not switch trace export on, so nothing is exported.
    expect(
      resolveMetrics(opts(), {
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://env/m",
      }),
    ).toEqual({ runtime: true, export: false });
  });

  it("headers: generic, then metrics variable, then option, key by key; timeout from the option", () => {
    const m = resolveMetrics(
      {
        export: {
          otlp: {
            endpoint: "http://c:4318",
            headers: { c: "option" },
            timeoutMillis: 1234,
          },
        },
      },
      {
        OTEL_EXPORTER_OTLP_HEADERS: "a=generic,b=generic,c=generic",
        OTEL_EXPORTER_OTLP_METRICS_HEADERS: "b=metrics,c=metrics",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "a=traces",
      },
    );
    expect(destination(m)).toMatchObject({
      headers: { a: "generic", b: "metrics", c: "option" },
      timeoutMillis: 1234,
    });
  });

  it.each([
    [undefined, DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS],
    ["250", 250],
    [" 250 ", 250],
    ["0", DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS],
    ["-5", DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS],
    ["1.5", DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS],
    ["soon", DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS],
  ])("OTEL_METRIC_EXPORT_INTERVAL=%j gives %d ms", (value, expected) => {
    const m = resolveMetrics(opts("http://c:4318"), {
      OTEL_METRIC_EXPORT_INTERVAL: value,
    });
    expect(destination(m)?.intervalMillis).toBe(expected);
  });
});
