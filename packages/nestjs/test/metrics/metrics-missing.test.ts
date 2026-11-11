// Global state: no host tracer provider, so Nestrix owns it, with OTLP export to a stub receiver.
// The metrics SDK loader is replaced: once by an import of a package that does not exist (a real
// ERR_MODULE_NOT_FOUND), once by a loader that fails otherwise. A host MeterProvider is
// registered for the last test only.
// P6-02: missing packages give one log line and no failure; a host MeterProvider is never replaced.

import type { INestApplication } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { metrics } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../../src/diagnostics.js";
import { hasGlobalMeterProvider } from "../../src/metrics/binding.js";
import {
  METRICS_INSTALL_MESSAGE,
  type MetricsSdk,
  metricsSdkLoader,
} from "../../src/metrics/export.js";
import { startMetrics } from "../../src/metrics/index.js";
import { resolveOptions } from "../../src/resolve-options.js";
import { recordingDiagnostics } from "../otel-helpers.js";
import { bootOwned } from "../stats-fixture.js";
import {
  collect,
  durationCounts,
  hostMeterProvider,
  metricsModule,
} from "./fixture.js";
import { type MetricsReceiver, startMetricsReceiver } from "./receiver.js";

const realLoad = metricsSdkLoader.load;
// A specifier held in a variable, so neither tsc nor Vite tries to resolve it ahead of time.
const ABSENT = "@opentelemetry/nestrix-test-absent-package";
const missingLoad = () => import(ABSENT) as Promise<MetricsSdk>;

let app: INestApplication | undefined;
let receiver: MetricsReceiver;
beforeEach(async () => {
  resetDiagnosticsForTests();
  receiver = await startMetricsReceiver();
});
afterEach(async () => {
  metricsSdkLoader.load = realLoad;
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
  metrics.disable();
  await receiver.close();
});

describe("optional packages missing", () => {
  it("logs the install line once across two apps, requests are unaffected, nothing is registered or sent", async () => {
    metricsSdkLoader.load = missingLoad;
    const log = vi.spyOn(Logger.prototype, "log");
    for (const adapter of ["express", "fastify"] as const) {
      const booted = await bootOwned(
        adapter,
        metricsModule({
          export: { otlp: { endpoint: receiver.base, timeoutMillis: 1000 } },
        }),
      );
      app = booted.app;
      const res = await fetch(`${booted.baseUrl}/m/ok/1`);
      expect(res.status).toBe(200);
      expect(JSON.parse(await res.text())).toEqual({
        id: "1",
        recording: true,
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(hasGlobalMeterProvider()).toBe(false);
      await app.close();
      app = undefined;
    }
    const lines = log.mock.calls
      .map((call) => String(call[0]))
      .filter((m) => m.includes("OTLP metric export is off"));
    expect(lines).toEqual([METRICS_INSTALL_MESSAGE]);
    expect(METRICS_INSTALL_MESSAGE).toContain(
      "pnpm add @opentelemetry/sdk-metrics@^3.1.1 @opentelemetry/exporter-metrics-otlp-http@^0.301.1",
    );
    expect(getFailureCounts().size).toBe(0);
    expect(receiver.metricPosts()).toHaveLength(0);
  });

  it("the loader is the import of the missing package: a real ERR_MODULE_NOT_FOUND", async () => {
    await expect(missingLoad()).rejects.toMatchObject({
      code: "ERR_MODULE_NOT_FOUND",
    });
  });

  it("a load failure other than a missing package is counted, not logged as missing", async () => {
    metricsSdkLoader.load = () => Promise.reject(new Error("broken install"));
    const diagnostics = recordingDiagnostics();
    const started = startMetrics(
      resolveOptions({ export: { otlp: { endpoint: receiver.base } } }, {}),
      { ownsProvider: true },
      diagnostics,
    );
    started?.startExport();
    await started?.export?.ready;
    expect(diagnostics.logs.size).toBe(0);
    expect(diagnostics.failures.map((f) => f.where)).toEqual([
      "metrics.export.load",
    ]);
    await started?.shutdown();
  });
});

describe("a host MeterProvider", () => {
  it("is used as is and never replaced, even when Nestrix owns the tracer provider and exports traces", async () => {
    const host = hostMeterProvider();
    expect(metrics.setGlobalMeterProvider(host.provider)).toBe(true);
    const before = metrics.getMeterProvider();
    const log = vi.spyOn(Logger.prototype, "log");
    const booted = await bootOwned(
      "node",
      metricsModule({
        export: { otlp: { endpoint: receiver.base, timeoutMillis: 1000 } },
      }),
    );
    app = booted.app;
    expect((await fetch(`${booted.baseUrl}/m/ok/1`)).status).toBe(200);
    await expect
      .poll(async () => durationCounts(await collect(host.reader)).length)
      .toBe(1);
    await expect
      .poll(() =>
        log.mock.calls.some((c) =>
          String(c[0]).includes("A MeterProvider is already registered"),
        ),
      )
      .toBe(true);
    expect(metrics.getMeterProvider()).toBe(before);
    await app.close();
    app = undefined;
    // Still the host's after Nestrix shut down; Nestrix sent no metrics of its own.
    expect(metrics.getMeterProvider()).toBe(before);
    expect(receiver.metricPosts()).toHaveLength(0);
  });
});
