// Global state: the global meter provider, set and removed by each test.
// P6-02 units: the recorder's attribute rules and the binding's rebinding.
import {
  type Attributes,
  createNoopMeter,
  type Histogram,
  type Meter,
  type MeterProvider,
  metrics,
  trace,
} from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import type { RequestState } from "../../src/http/request-state.js";
import {
  hasGlobalMeterProvider,
  isNoopMeter,
  MeterBinding,
} from "../../src/metrics/binding.js";
import { HttpRequestMetrics } from "../../src/metrics/http.js";
import { recordingDiagnostics } from "../otel-helpers.js";

afterEach(() => metrics.disable());

/** A provider recording every `record` call, with a count of meters handed out. */
function recordingProvider() {
  const records: { value: number; attributes: Attributes | undefined }[] = [];
  let meters = 0;
  const noop = createNoopMeter();
  const histogram: Histogram = {
    record: (value, attributes) => records.push({ value, attributes }),
  };
  // A plain object, so it is not the API's no-op meter; runtime instruments stay off here.
  const meter: Meter = {
    createCounter: (n, o) => noop.createCounter(n, o),
    createGauge: (n, o) => noop.createGauge(n, o),
    createHistogram: () => histogram,
    createUpDownCounter: (n, o) => noop.createUpDownCounter(n, o),
    createObservableGauge: (n, o) => noop.createObservableGauge(n, o),
    createObservableCounter: (n, o) => noop.createObservableCounter(n, o),
    createObservableUpDownCounter: (n, o) =>
      noop.createObservableUpDownCounter(n, o),
    addBatchObservableCallback: () => undefined,
    removeBatchObservableCallback: () => undefined,
  };
  const provider: MeterProvider = {
    getMeter() {
      meters++;
      return meter;
    },
  };
  return { provider, records, meters: () => meters };
}

function state(overrides: Partial<RequestState> = {}): RequestState {
  return {
    span: trace.wrapSpanContext({
      traceId: `${"0".repeat(31)}1`,
      spanId: `${"0".repeat(15)}1`,
      traceFlags: 0,
    }),
    method: "GET",
    baseName: "GET",
    route: undefined,
    reached: true,
    exception: undefined,
    ended: false,
    startedAt: performance.now() - 25,
    ...overrides,
  };
}

function recorder(runtime = false) {
  const diagnostics = recordingDiagnostics();
  const binding = new MeterBinding(runtime, diagnostics);
  return {
    binding,
    diagnostics,
    http: new HttpRequestMetrics(binding, diagnostics),
  };
}

describe("HttpRequestMetrics.record", () => {
  it("records seconds with method, route and status", () => {
    const p = recordingProvider();
    metrics.setGlobalMeterProvider(p.provider);
    recorder().http.record(state(), 201, "/a/:id");
    expect(p.records).toHaveLength(1);
    expect(p.records[0]?.attributes).toEqual({
      "http.request.method": "GET",
      "http.route": "/a/:id",
      "http.response.status_code": 201,
    });
    expect(p.records[0]?.value).toBeGreaterThan(0.02);
    expect(p.records[0]?.value).toBeLessThan(1);
  });

  it("nothing sent and a handler exception that maps to 5xx: error.type is the exception, no status", () => {
    const p = recordingProvider();
    metrics.setGlobalMeterProvider(p.provider);
    recorder().http.record(
      state({ exception: { status: 500, type: "TypeError" } }),
      undefined,
      "/x",
    );
    expect(p.records[0]?.attributes).toEqual({
      "http.request.method": "GET",
      "http.route": "/x",
      "error.type": "TypeError",
    });
  });

  it("a 503 sent with no exception: error.type is the status; a 4xx exception is not an error", () => {
    const p = recordingProvider();
    metrics.setGlobalMeterProvider(p.provider);
    const { http } = recorder();
    http.record(state(), 503, undefined);
    http.record(
      state({ exception: { status: 404, type: "NotFoundException" } }),
      404,
      undefined,
    );
    expect(p.records.map((r) => r.attributes?.["error.type"])).toEqual([
      "503",
      undefined,
    ]);
  });

  it("a method outside the conventions' list is _OTHER", () => {
    const p = recordingProvider();
    metrics.setGlobalMeterProvider(p.provider);
    recorder().http.record(
      state({ method: "PURGE", baseName: "HTTP" }),
      200,
      undefined,
    );
    expect(p.records[0]?.attributes?.["http.request.method"]).toBe("_OTHER");
  });

  it("records nothing, and builds nothing, while no real provider is registered", () => {
    expect(hasGlobalMeterProvider()).toBe(false);
    const { binding, http, diagnostics } = recorder();
    expect(binding.requestDuration()).toBeUndefined();
    http.record(state(), 200, "/a");
    expect(diagnostics.failures).toEqual([]);
  });

  it("no start time recorded: nothing", () => {
    const p = recordingProvider();
    metrics.setGlobalMeterProvider(p.provider);
    recorder().http.record(state({ startedAt: 0 }), 200, "/a");
    expect(p.records).toHaveLength(0);
  });
});

describe("MeterBinding", () => {
  it("rebinds when the global provider changes, and only then", () => {
    const { binding, http } = recorder();
    http.record(state(), 200, "/a"); // no provider yet
    const first = recordingProvider();
    metrics.setGlobalMeterProvider(first.provider);
    http.record(state(), 200, "/a");
    http.record(state(), 200, "/a");
    expect(first.meters()).toBe(1);
    expect(first.records).toHaveLength(2);

    metrics.disable();
    const second = recordingProvider();
    metrics.setGlobalMeterProvider(second.provider);
    http.record(state(), 200, "/a");
    expect(second.meters()).toBe(1);
    expect(second.records).toHaveLength(1);
    expect(first.records).toHaveLength(2);

    binding.close();
    http.record(state(), 200, "/a");
    expect(second.records).toHaveLength(1);
  });

  it("isNoopMeter tells the API's no-op meter from a real one", () => {
    expect(isNoopMeter(createNoopMeter())).toBe(true);
    expect(isNoopMeter(metrics.getMeter("x"))).toBe(true);
    expect(isNoopMeter(recordingProvider().provider.getMeter("x"))).toBe(false);
    expect(isNoopMeter(undefined)).toBe(true);
  });
});
