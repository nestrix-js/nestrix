// Global state: Nestrix owns the tracer provider at sampleRate 0 (export off); a host-style SDK
// MeterProvider with a pull reader is the global meter provider, replaced before each test.
// P6-02: the request histogram on all three adapters, every request counted although no span
// records; runtime instruments; `metrics: false` and `runtime: false`.
import { setTimeout as sleep } from "node:timers/promises";
import type { INestApplication } from "@nestjs/common";
import { metrics } from "@opentelemetry/api";
import type { Histogram } from "@opentelemetry/sdk-metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../../src/diagnostics.js";
import { HTTP_DURATION_BUCKETS } from "../../src/metrics/binding.js";
import { RUNTIME_METRIC_NAMES } from "../../src/metrics/runtime.js";
import { bootOwned } from "../stats-fixture.js";
import {
  ADAPTERS,
  collect,
  durationCounts,
  hostMeterProvider,
  metricNames,
  metricsModule,
  points,
  scopeNames,
  type TestReader,
} from "./fixture.js";

let app: INestApplication | undefined;
let reader: TestReader;

beforeEach(() => {
  resetDiagnosticsForTests();
  metrics.disable();
  const host = hostMeterProvider();
  reader = host.reader;
  expect(metrics.setGlobalMeterProvider(host.provider)).toBe(true);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function cpuUser(rm: Awaited<ReturnType<typeof collect>>): number | undefined {
  return points(rm, "process.cpu.time").find(
    (p) => p.attributes["cpu.mode"] === "user",
  )?.value as number | undefined;
}

function burnCpu(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // busy
  }
}

async function get(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.text() };
}

describe.each(ADAPTERS)("http.server.request.duration on %s", (adapter) => {
  it("records every request at sampleRate 0 with method, route, status and error.type", async () => {
    const booted = await bootOwned(
      adapter,
      metricsModule({ export: { otlp: false }, sampleRate: 0 }),
    );
    app = booted.app;
    for (let i = 1; i <= 5; i++) {
      const res = await get(booted.baseUrl, `/m/ok/${i}`);
      expect(res.status).toBe(200);
      // No span records at sampleRate 0, yet every request is counted below.
      expect(JSON.parse(res.body)).toEqual({ id: String(i), recording: false });
    }
    expect((await get(booted.baseUrl, "/m/boom")).status).toBe(500);
    expect((await get(booted.baseUrl, "/m/boom")).status).toBe(500);
    expect((await get(booted.baseUrl, "/m/bad")).status).toBe(400);
    expect((await get(booted.baseUrl, "/nope")).status).toBe(404);

    // Recorded at the raw response's `close`, which may follow the client's read by a tick.
    await expect
      .poll(async () => durationCounts(await collect(reader)))
      .toEqual([
        {
          attributes: {
            "http.request.method": "GET",
            "http.response.status_code": 404,
          },
          count: 1,
        },
        {
          attributes: {
            "http.request.method": "GET",
            "http.route": "/m/bad",
            "http.response.status_code": 400,
          },
          count: 1,
        },
        {
          attributes: {
            "error.type": "TypeError",
            "http.request.method": "GET",
            "http.route": "/m/boom",
            "http.response.status_code": 500,
          },
          count: 2,
        },
        {
          attributes: {
            "http.request.method": "GET",
            "http.route": "/m/ok/:id",
            "http.response.status_code": 200,
          },
          count: 5,
        },
      ]);

    const rm = await collect(reader);
    expect(scopeNames(rm)).toEqual(["@nestrix/nestjs"]);
    const metric = rm.scopeMetrics[0]?.metrics.find(
      (m) => m.descriptor.name === "http.server.request.duration",
    );
    expect(metric?.descriptor.unit).toBe("s");
    const ok = points(rm, "http.server.request.duration").find(
      (p) => p.attributes["http.route"] === "/m/ok/:id",
    );
    const value = ok?.value as Histogram;
    expect(value.buckets.boundaries).toEqual([...HTTP_DURATION_BUCKETS]);
    expect(value.sum).toBeGreaterThan(0);
    expect(value.max).toBeLessThan(5); // seconds, not milliseconds
    expect(getFailureCounts().size).toBe(0);
  });
});

describe("runtime instruments", () => {
  it("report event-loop delay, heap per space, RSS and CPU time on the host provider", async () => {
    const booted = await bootOwned(
      "express",
      metricsModule({ export: { otlp: false } }),
    );
    app = booted.app;
    await sleep(150); // enough 20 ms event-loop samples for the delay gauges
    const rm = await collect(reader);
    const names = metricNames(rm);
    for (const name of Object.values(RUNTIME_METRIC_NAMES)) {
      expect(names).toContain(name);
    }
    const rss = points(rm, "process.memory.usage");
    expect(rss).toHaveLength(1);
    expect(rss[0]?.value as number).toBeGreaterThan(10 * 1024 * 1024);
    const cpu = points(rm, "process.cpu.time");
    expect(cpu.map((p) => p.attributes["cpu.mode"]).sort()).toEqual([
      "system",
      "user",
    ]);
    expect(cpu.every((p) => (p.value as number) > 0)).toBe(true);
    const heap = points(rm, "v8js.memory.heap.used");
    const spaces = heap.map((p) => p.attributes["v8js.heap.space.name"]);
    expect(spaces).toContain("new_space");
    expect(spaces).toContain("old_space");
    const delay = points(rm, "nodejs.eventloop.delay.p99")[0]?.value as number;
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThan(5); // seconds, not nanoseconds
    // Deprecated in semantic-conventions 1.45.0; not reported.
    expect(names).not.toContain("v8js.memory.heap.limit");

    // While the app runs, each collection reads the CPU clock anew...
    const before1 = cpuUser(await collect(reader));
    burnCpu(30);
    const before2 = cpuUser(await collect(reader));
    expect(before2).toBeGreaterThan(before1 as number);

    // ...and after shutdown the callback is gone: no new reading, whatever the SDK keeps.
    await app.close();
    app = undefined;
    const after1 = cpuUser(await collect(reader));
    burnCpu(30);
    const after2 = cpuUser(await collect(reader));
    expect(after2).toBe(after1);
  });

  it("runtime: false records the request histogram only", async () => {
    const booted = await bootOwned(
      "express",
      metricsModule({ export: { otlp: false }, metrics: { runtime: false } }),
    );
    app = booted.app;
    expect((await get(booted.baseUrl, "/m/ok/1")).status).toBe(200);
    await expect
      .poll(async () => metricNames(await collect(reader)))
      .toEqual(["http.server.request.duration"]);
  });

  it("metrics: false records nothing", async () => {
    const booted = await bootOwned(
      "fastify",
      metricsModule({ export: { otlp: false }, metrics: false }),
    );
    app = booted.app;
    expect((await get(booted.baseUrl, "/m/ok/1")).status).toBe(200);
    await sleep(50);
    expect(metricNames(await collect(reader))).toEqual([]);
  });
});
