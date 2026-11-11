// Global state: no host SDK. Nestrix owns the tracer provider with OTLP export to a stub
// receiver, and so registers its own MeterProvider (the optional packages are devDependencies).
// P6-02: export to `/v1/metrics`, interval from OTEL_METRIC_EXPORT_INTERVAL, the metrics endpoint
// variable, flush on shutdown, a bounded shutdown against a receiver that never answers.
import type { INestApplication } from "@nestjs/common";
import { metrics } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../../src/diagnostics.js";
import { hasGlobalMeterProvider } from "../../src/metrics/binding.js";
import { RUNTIME_METRIC_NAMES } from "../../src/metrics/runtime.js";
import { bootOwned } from "../stats-fixture.js";
import { metricsModule } from "./fixture.js";
import {
  type MetricsReceiver,
  receivedMetrics,
  requestCount,
  startMetricsReceiver,
} from "./receiver.js";

let app: INestApplication | undefined;
let receiver: MetricsReceiver;

beforeEach(async () => {
  resetDiagnosticsForTests();
  receiver = await startMetricsReceiver();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllEnvs();
  await receiver.close();
});

async function hit(baseUrl: string, path: string, times: number) {
  for (let i = 0; i < times; i++) {
    const res = await fetch(`${baseUrl}${path}`);
    await res.arrayBuffer();
    expect(res.status).toBe(200);
  }
}

describe("OTLP metric export", () => {
  it("exports the request histogram and runtime metrics to /v1/metrics every OTEL_METRIC_EXPORT_INTERVAL ms, with the option's headers and resource", async () => {
    vi.stubEnv("OTEL_METRIC_EXPORT_INTERVAL", "100");
    expect(hasGlobalMeterProvider()).toBe(false);
    const booted = await bootOwned(
      "fastify",
      metricsModule({
        serviceName: "metrics-export-test",
        export: {
          otlp: {
            endpoint: receiver.base,
            headers: { authorization: "Bearer metrics" },
            timeoutMillis: 2000,
          },
        },
      }),
    );
    app = booted.app;
    await hit(booted.baseUrl, "/m/ok/1", 4);

    // Periodic: arrives without any flush.
    await expect
      .poll(() => requestCount(receiver.metricPosts(), "/m/ok/:id"), {
        timeout: 5000,
      })
      .toBe(4);
    expect(receiver.metricPosts().length).toBeGreaterThanOrEqual(1);
    expect(hasGlobalMeterProvider()).toBe(true);

    const post = receiver.metricPosts()[0];
    expect(post?.path).toBe("/v1/metrics");
    expect(post?.headers.authorization).toBe("Bearer metrics");
    const all = receivedMetrics(receiver.metricPosts());
    const names = new Set(all.map((m) => m.name));
    for (const name of Object.values(RUNTIME_METRIC_NAMES)) {
      expect(names).toContain(name);
    }
    const duration = all.find((m) => m.name === "http.server.request.duration");
    expect(duration?.unit).toBe("s");
    expect(duration?.scope).toBe("@nestrix/nestjs");
    expect(duration?.resource["service.name"]).toBe("metrics-export-test");

    await app.close();
    app = undefined;
    // Nestrix removed its own registration, so a later app can own it again.
    expect(hasGlobalMeterProvider()).toBe(false);
    expect(getFailureCounts().size).toBe(0);
  });

  it("flushes on shutdown with the default 60 s interval", async () => {
    const booted = await bootOwned(
      "express",
      metricsModule({
        export: { otlp: { endpoint: receiver.base, timeoutMillis: 2000 } },
      }),
    );
    app = booted.app;
    await hit(booted.baseUrl, "/m/ok/7", 3);
    // Nestrix's provider is registered once the dynamic import resolved.
    await expect.poll(() => hasGlobalMeterProvider()).toBe(true);
    expect(receiver.metricPosts()).toHaveLength(0);

    await app.close();
    app = undefined;
    expect(requestCount(receiver.metricPosts(), "/m/ok/:id")).toBe(3);
  });

  it("honours OTEL_EXPORTER_OTLP_METRICS_ENDPOINT as given", async () => {
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      `${receiver.base}/v1/traces`,
    );
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
      `${receiver.base}/custom/metrics`,
    );
    const booted = await bootOwned("node", metricsModule({}));
    app = booted.app;
    await hit(booted.baseUrl, "/m/ok/2", 2);
    await expect.poll(() => hasGlobalMeterProvider()).toBe(true);
    await app.close();
    app = undefined;
    expect(receiver.metricPosts().map((p) => p.path)).toEqual([
      "/custom/metrics",
    ]);
    expect(requestCount(receiver.metricPosts(), "/m/ok/:id")).toBe(2);
  });

  it("shutdown is bounded when the receiver never answers", async () => {
    receiver.hang = true;
    const booted = await bootOwned(
      "express",
      metricsModule({
        export: { otlp: { endpoint: receiver.base, timeoutMillis: 300 } },
      }),
    );
    app = booted.app;
    await hit(booted.baseUrl, "/m/ok/3", 1);
    await expect.poll(() => hasGlobalMeterProvider()).toBe(true);
    const started = performance.now();
    await app.close();
    app = undefined;
    const elapsed = performance.now() - started;
    expect(receiver.metricPosts().length).toBeGreaterThanOrEqual(1);
    expect(elapsed).toBeLessThan(5_500);
    expect(hasGlobalMeterProvider()).toBe(false);
  });

  it("does not register a MeterProvider when trace export is off", async () => {
    const booted = await bootOwned(
      "express",
      metricsModule({ export: { otlp: false } }),
    );
    app = booted.app;
    await hit(booted.baseUrl, "/m/ok/4", 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(hasGlobalMeterProvider()).toBe(false);
    expect(metrics.getMeterProvider().constructor.name).toBe(
      "NoopMeterProvider",
    );
  });
});
