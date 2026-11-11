// Global state: a host tracer provider whose sampler records nothing (AlwaysOff), with an ALS
// context manager and W3C propagator; the global meter provider is replaced before each test.
// P6-02: the histogram under a host-owned sampler, and rule 1 for metrics: a meter, histogram or
// runtime source that throws changes no response, and the fault is counted.
import type { INestApplication } from "@nestjs/common";
import {
  context,
  createNoopMeter,
  type Meter,
  type MeterProvider,
  metrics,
  propagation,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AlwaysOffSampler, TracerProvider } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../../src/diagnostics.js";
import { bootOwned } from "../stats-fixture.js";
import {
  ADAPTERS,
  collect,
  durationCounts,
  hostMeterProvider,
  metricsModule,
  points,
} from "./fixture.js";

trace.setGlobalTracerProvider(
  new TracerProvider({ sampler: new AlwaysOffSampler() }),
);
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

let app: INestApplication | undefined;
beforeEach(() => {
  resetDiagnosticsForTests();
  metrics.disable();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
});

const PATHS = ["/m/ok/1", "/m/boom", "/m/bad", "/nope"];

interface Seen {
  status: number;
  body: string;
  type: string | null;
}

async function exchange(baseUrl: string): Promise<Seen[]> {
  const out: Seen[] = [];
  for (const path of PATHS) {
    const res = await fetch(`${baseUrl}${path}`);
    out.push({
      status: res.status,
      body: await res.text(),
      type: res.headers.get("content-type"),
    });
  }
  return out;
}

/** What the app answers with metrics off: the baseline a fault must not change. */
async function baseline(adapter: (typeof ADAPTERS)[number]): Promise<Seen[]> {
  const booted = await bootOwned(adapter, metricsModule({ metrics: false }));
  try {
    return await exchange(booted.baseUrl);
  } finally {
    await booted.app.close();
  }
}

/** A provider whose meter is a real object (not the API's no-op) with `overrides` applied. */
function faultyProvider(overrides: Partial<Meter>): MeterProvider {
  const noop = createNoopMeter();
  const meter: Meter = {
    createCounter: (n, o) => noop.createCounter(n, o),
    createGauge: (n, o) => noop.createGauge(n, o),
    createHistogram: (n, o) => noop.createHistogram(n, o),
    createUpDownCounter: (n, o) => noop.createUpDownCounter(n, o),
    createObservableGauge: (n, o) => noop.createObservableGauge(n, o),
    createObservableCounter: (n, o) => noop.createObservableCounter(n, o),
    createObservableUpDownCounter: (n, o) =>
      noop.createObservableUpDownCounter(n, o),
    addBatchObservableCallback: () => undefined,
    removeBatchObservableCallback: () => undefined,
    ...overrides,
  };
  return { getMeter: () => meter };
}

describe.each(ADAPTERS)("host-owned SDK on %s", (adapter) => {
  it("records the histogram although the host sampler records no span", async () => {
    const host = hostMeterProvider();
    metrics.setGlobalMeterProvider(host.provider);
    const booted = await bootOwned(adapter, metricsModule({}));
    app = booted.app;
    const seen = await exchange(booted.baseUrl);
    expect(seen.map((s) => s.status)).toEqual([200, 500, 400, 404]);
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      id: "1",
      recording: false,
    });
    await expect
      .poll(async () =>
        durationCounts(await collect(host.reader)).map(
          (p) =>
            `${p.attributes["http.route"] ?? "-"} ${p.attributes["http.response.status_code"]} ${p.count}`,
        ),
      )
      .toEqual(["- 404 1", "/m/bad 400 1", "/m/boom 500 1", "/m/ok/:id 200 1"]);
  });

  it.each([
    [
      "histogram.record throws",
      () =>
        faultyProvider({
          createHistogram: () => ({
            record() {
              throw new Error("record fault");
            },
          }),
        }),
      "metrics.http-record",
    ],
    [
      "getMeter throws",
      (): MeterProvider => ({
        getMeter() {
          throw new Error("getMeter fault");
        },
      }),
      "metrics.get-meter",
    ],
    [
      "createHistogram throws",
      () =>
        faultyProvider({
          createHistogram() {
            throw new Error("createHistogram fault");
          },
        }),
      "metrics.create-histogram",
    ],
    [
      "addBatchObservableCallback throws",
      () =>
        faultyProvider({
          addBatchObservableCallback() {
            throw new Error("runtime fault");
          },
        }),
      "metrics.runtime-start",
    ],
  ])(
    "%s: responses are unchanged and the fault is counted",
    async (_name, provider, site) => {
      const expected = await baseline(adapter);
      resetDiagnosticsForTests();
      metrics.setGlobalMeterProvider(provider());
      const booted = await bootOwned(adapter, metricsModule({}));
      app = booted.app;
      expect(await exchange(booted.baseUrl)).toEqual(expected);
      await app.close();
      app = undefined;
      expect(getFailureCounts().get(site)).toBeGreaterThanOrEqual(1);
    },
  );
});

describe("runtime source fault", () => {
  it("a throwing process.cpuUsage drops CPU time only; the other runtime metrics still report", async () => {
    const host = hostMeterProvider();
    metrics.setGlobalMeterProvider(host.provider);
    const booted = await bootOwned("express", metricsModule({}));
    app = booted.app;
    vi.spyOn(process, "cpuUsage").mockImplementation(() => {
      throw new Error("cpuUsage fault");
    });
    const rm = await collect(host.reader);
    expect(points(rm, "process.cpu.time")).toHaveLength(0);
    expect(points(rm, "process.memory.usage")).toHaveLength(1);
    expect(points(rm, "v8js.memory.heap.used").length).toBeGreaterThan(0);
    expect(getFailureCounts().get("metrics.runtime.cpu")).toBe(1);
  });
});
