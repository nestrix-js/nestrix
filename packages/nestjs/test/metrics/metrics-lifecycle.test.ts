// Global state: the global meter provider. P6-02 fix round: the owned export starts at
// onApplicationBootstrap (after every host onModuleInit), `metrics.export: false`, and a second
// app booted while the first app's owned export is still flushing.
import {
  Controller,
  Get,
  type INestApplication,
  Module,
  type OnModuleInit,
} from "@nestjs/common";
import { metrics } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../../src/diagnostics.js";
import { hasGlobalMeterProvider } from "../../src/metrics/binding.js";
import { NestrixModule } from "../../src/nestrix.module.js";
import { bootOwned } from "../stats-fixture.js";
import {
  collect,
  durationCounts,
  hostMeterProvider,
  metricsModule,
} from "./fixture.js";
import { type MetricsReceiver, startMetricsReceiver } from "./receiver.js";

let app: INestApplication | undefined;
let second: INestApplication | undefined;
let receiver: MetricsReceiver;

beforeEach(async () => {
  resetDiagnosticsForTests();
  metrics.disable();
  receiver = await startMetricsReceiver();
});
afterEach(async () => {
  await app?.close();
  await second?.close();
  app = undefined;
  second = undefined;
  vi.unstubAllEnvs();
  await receiver.close();
  metrics.disable();
});

async function hit(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  await res.arrayBuffer();
  expect(res.status).toBe(200);
}

describe("a host that registers its MeterProvider in onModuleInit", () => {
  it("wins: registration succeeds, the host reader gets the histogram, Nestrix exports nothing", async () => {
    const host = hostMeterProvider();
    const registered: boolean[] = [];

    @Controller("m")
    class Ctl {
      @Get("ok")
      ok() {
        return { ok: true };
      }
    }

    class HostMetrics implements OnModuleInit {
      onModuleInit() {
        registered.push(metrics.setGlobalMeterProvider(host.provider));
      }
    }
    @Module({
      imports: [
        NestrixModule.forRoot({
          ui: false,
          export: { otlp: { endpoint: receiver.base } },
        }),
      ],
      controllers: [Ctl],
      providers: [HostMetrics],
    })
    class Root {}

    const booted = await bootOwned("express", Root);
    app = booted.app;
    expect(registered).toEqual([true]);
    await hit(booted.baseUrl, "/m/ok");
    await expect
      .poll(async () => durationCounts(await collect(host.reader)).length)
      .toBe(1);
    expect(metrics.getMeterProvider()).toBe(host.provider);
    await app.close();
    app = undefined;
    expect(receiver.metricPosts()).toHaveLength(0);
    expect(getFailureCounts().size).toBe(0);
  });
});

describe("metrics.export: false", () => {
  it("never registers a provider or posts, and a host provider still receives the metrics", async () => {
    vi.stubEnv("OTEL_METRIC_EXPORT_INTERVAL", "50");
    const booted = await bootOwned(
      "express",
      metricsModule({
        metrics: { export: false },
        export: { otlp: { endpoint: receiver.base } },
      }),
    );
    app = booted.app;
    await hit(booted.baseUrl, "/m/ok/1");
    await new Promise((r) => setTimeout(r, 200));
    expect(hasGlobalMeterProvider()).toBe(false);
    expect(receiver.metricPosts()).toHaveLength(0);

    // API-only recording: a provider registered later is bound and receives the histogram.
    const host = hostMeterProvider();
    expect(metrics.setGlobalMeterProvider(host.provider)).toBe(true);
    await hit(booted.baseUrl, "/m/ok/2");
    await expect
      .poll(async () => durationCounts(await collect(host.reader)).length)
      .toBe(1);
  });
});

describe("a second app booted while the first app's export flushes", () => {
  it("exports: the new load waits for the old provider's metrics.disable()", async () => {
    const options = {
      export: { otlp: { endpoint: receiver.base, timeoutMillis: 1500 } },
    };
    receiver.hang = true;
    const first = await bootOwned("express", metricsModule(options));
    app = first.app;
    await hit(first.baseUrl, "/m/ok/1");
    await expect.poll(() => hasGlobalMeterProvider()).toBe(true);

    // The flush hangs until the export timeout. The shut-down SDK provider reads as "none" to the
    // probe while it is still the registered one, so a new load must wait for its disable().
    const closing = app.close();
    app = undefined;
    // Past the first app's shutdown start, so the second one cannot join its (closing) export.
    await new Promise((r) => setTimeout(r, 150));
    const booted = await bootOwned("express", metricsModule(options));
    second = booted.app;
    await closing;
    receiver.hang = false;
    const before = receiver.metricPosts().length;

    await expect.poll(() => hasGlobalMeterProvider()).toBe(true);
    await hit(booted.baseUrl, "/m/ok/2");
    await second.close();
    second = undefined;
    expect(receiver.metricPosts().length).toBeGreaterThan(before);
    expect(hasGlobalMeterProvider()).toBe(false);
  });
});
