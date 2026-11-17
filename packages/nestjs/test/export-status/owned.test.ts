// Global state: no host tracer provider. Nestrix owns the provider and exports traces, metrics and
// (where set) logs to a local sink that answers chosen statuses (D-82, #21, #39), through the real
// OTLP exporters on platform-node.
import type { INestApplication } from "@nestjs/common";
import { metrics } from "@opentelemetry/api";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { resetDiagnosticsForTests } from "../../src/diagnostics.js";
import {
  exportStatusLog,
  getExportStatus,
  resetExportStatusForTests,
} from "../../src/export-status.js";
import { NestrixLogger } from "../../src/logs/logger.js";
import {
  hasGlobalMeterProvider,
  METRIC_EXPORT_DROPPED,
  METRIC_EXPORT_FAILURES,
} from "../../src/metrics/binding.js";
import type { NestrixModuleOptions } from "../../src/options.js";
import {
  collect,
  hostMeterProvider,
  metricsModule,
  points,
} from "../metrics/fixture.js";
import { bootOwned, sendAll } from "../stats-fixture.js";
import { type StatusSink, startStatusSink } from "./sink.js";

let app: INestApplication | undefined;
let sink: StatusSink;
let warn: MockInstance<(message: string) => void>;
let info: MockInstance<(message: string) => void>;
let ticker: NodeJS.Timeout | undefined;

beforeEach(async () => {
  resetDiagnosticsForTests();
  resetExportStatusForTests();
  metrics.disable();
  sink = await startStatusSink();
  warn = vi.spyOn(exportStatusLog, "warn").mockImplementation(() => {});
  info = vi.spyOn(exportStatusLog, "log").mockImplementation(() => {});
});
afterEach(async () => {
  clearInterval(ticker);
  ticker = undefined;
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  metrics.disable();
  await sink.close();
});

async function boot(options: NestrixModuleOptions = {}): Promise<string> {
  const booted = await bootOwned(
    "node",
    metricsModule({
      serviceName: "export-status-test",
      ...options,
      export: {
        otlp: { endpoint: sink.base, timeoutMillis: 800 },
        queue: { scheduledDelayMillis: 100 },
        ...options.export,
      },
    }),
  );
  app = booted.app;
  return booted.baseUrl;
}

/** Keeps requests coming, so every batch interval has spans to export. */
function keepTraffic(baseUrl: string): void {
  ticker = setInterval(() => {
    fetch(`${baseUrl}/m/ok/1`).then(
      (r) => r.arrayBuffer(),
      () => undefined,
    );
  }, 50);
}

const warnings = (signal: string) =>
  warn.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes(`Exports of ${signal} `));
const recoveries = (signal: string) =>
  info.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.startsWith(`Exporting ${signal} `));

describe("export status with Nestrix's own pipeline", () => {
  it("#21: stopping the backend gives one warning within one export interval, and one recovery line after it is back", async () => {
    vi.stubEnv("OTEL_METRIC_EXPORT_INTERVAL", "500");
    const baseUrl = await boot();
    keepTraffic(baseUrl);
    await expect
      .poll(() => getExportStatus().traces.state, { timeout: 5000 })
      .toBe("ok");
    await expect
      .poll(() => getExportStatus().metrics.state, { timeout: 5000 })
      .toBe("ok");

    await sink.down();
    const stoppedAt = Date.now();
    // Within one export interval: the batch delay (or metric interval) plus the exporter's
    // timeout (800 ms), which is when the exporter gives up on its retries.
    await expect
      .poll(() => warnings("spans").length, { timeout: 3000 })
      .toBe(1);
    await expect
      .poll(() => warnings("metrics").length, { timeout: 3000 })
      .toBe(1);
    expect(Date.now() - stoppedAt).toBeLessThan(3000);
    expect(warnings("spans")[0]).toContain("(unreachable: ");
    const failing = getExportStatus();
    expect(failing.degraded).toBe(true);
    expect(failing.traces.lastFailure).toEqual({
      reason: "unreachable",
      httpStatus: null,
    });
    // More failed exports, no more lines.
    await expect
      .poll(() => getExportStatus().traces.consecutiveFailures, {
        timeout: 5000,
      })
      .toBeGreaterThanOrEqual(3);
    expect(warnings("spans")).toHaveLength(1);
    expect(warnings("metrics")).toHaveLength(1);

    await sink.up();
    await expect
      .poll(() => recoveries("spans").length, { timeout: 5000 })
      .toBe(1);
    await expect
      .poll(() => recoveries("metrics").length, { timeout: 5000 })
      .toBe(1);
    const recovered = getExportStatus();
    expect(recovered.degraded).toBe(false);
    expect(recovered.traces.state).toBe("ok");
    expect(recovered.traces.consecutiveFailures).toBe(0);
    expect(recovered.traces.failures.unreachable).toBeGreaterThanOrEqual(3);
    await new Promise((r) => setTimeout(r, 600));
    expect(recoveries("spans")).toHaveLength(1);
    expect(warnings("spans")).toHaveLength(1);
  });

  it("#21: a 401 (revoked key) and a 429 are reported distinctly, for traces and metrics, with no extra exports", async () => {
    vi.stubEnv("OTEL_METRIC_EXPORT_INTERVAL", "300");
    sink.status["/v1/traces"] = 401;
    sink.status["/v1/metrics"] = 401;
    const baseUrl = await boot();
    keepTraffic(baseUrl);
    await expect
      .poll(() => getExportStatus().traces.lastFailure, { timeout: 5000 })
      .toEqual({ reason: "unauthorized", httpStatus: 401 });
    await expect
      .poll(() => getExportStatus().metrics.lastFailure, { timeout: 5000 })
      .toEqual({ reason: "unauthorized", httpStatus: 401 });
    expect(warnings("spans")[0]).toContain("(unauthorized, HTTP 401: ");

    sink.status["/v1/traces"] = 429;
    sink.status["/v1/metrics"] = 429;
    await expect
      .poll(() => getExportStatus().traces.lastFailure, { timeout: 5000 })
      .toEqual({ reason: "rate_limited", httpStatus: 429 });
    await expect
      .poll(() => getExportStatus().metrics.lastFailure, { timeout: 5000 })
      .toEqual({ reason: "rate_limited", httpStatus: 429 });
    expect(warnings("spans")).toHaveLength(2);
    expect(warnings("spans")[1]).toContain(
      "now fail for another reason (rate_limited, HTTP 429: ",
    );
    const { traces, metrics: m } = getExportStatus();
    expect(traces.failures.unauthorized).toBeGreaterThanOrEqual(1);
    expect(traces.failures.rate_limited).toBeGreaterThanOrEqual(1);
    expect(m.failures.unauthorized).toBeGreaterThanOrEqual(1);
    expect(m.failures.rate_limited).toBeGreaterThanOrEqual(1);

    // No feedback loop: a failing metric export (which reports its own failure in the next one)
    // still sends one request per interval and per retry, nothing more.
    const before = sink.count("/v1/metrics");
    const started = Date.now();
    await new Promise((r) => setTimeout(r, 1500));
    const intervals = (Date.now() - started) / 300;
    expect(sink.count("/v1/metrics") - before).toBeLessThanOrEqual(
      Math.ceil(intervals) + 1,
    );
  });

  it("#39: an endpoint that answers 404 to metrics gets one line, metric export stops, traces continue", async () => {
    vi.stubEnv("OTEL_METRIC_EXPORT_INTERVAL", "200");
    sink.status["/v1/metrics"] = 404;
    const baseUrl = await boot();
    keepTraffic(baseUrl);
    await expect
      .poll(() => getExportStatus().metrics.state, { timeout: 5000 })
      .toBe("stopped");
    await expect
      .poll(() => hasGlobalMeterProvider(), { timeout: 5000 })
      .toBe(false);
    const metricPosts = sink.count("/v1/metrics");
    const tracePosts = sink.count("/v1/traces");
    await new Promise((r) => setTimeout(r, 1200));
    expect(sink.count("/v1/metrics")).toBe(metricPosts);
    expect(metricPosts).toBe(1);
    expect(sink.count("/v1/traces")).toBeGreaterThan(tracePosts);
    expect(getExportStatus().traces.state).toBe("ok");
    expect(getExportStatus().metrics).toMatchObject({
      state: "stopped",
      lastFailure: { reason: "not_supported", httpStatus: 404 },
      consecutiveFailures: 1,
    });
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^The OTLP endpoint does not accept metrics \(HTTP 404 on its metrics URL\), so Nestrix stopped exporting metrics/,
    );
    // Closing afterwards is clean and still bounded.
    const closing = Date.now();
    await app?.close();
    app = undefined;
    expect(Date.now() - closing).toBeLessThan(3000);
    expect(getExportStatus().metrics.state).toBe("inactive");
  });

  it("#21: spans dropped from the full queue are counted, and both counters reach a host MeterProvider", async () => {
    // Nestrix owns the tracer provider; the host registered only a MeterProvider (D-66), so
    // Nestrix's metrics, these two included, go to it.
    const host = hostMeterProvider();
    metrics.setGlobalMeterProvider(host.provider);
    sink.delay["/v1/traces"] = 1500;
    const baseUrl = await boot({
      export: {
        otlp: { endpoint: sink.base, timeoutMillis: 800 },
        queue: {
          maxQueueSize: 2,
          maxExportBatchSize: 1,
          scheduledDelayMillis: 20,
        },
      },
    });
    await sendAll(
      baseUrl,
      Array.from({ length: 40 }, () => "/m/ok/1"),
      8,
    );
    await expect
      .poll(() => getExportStatus().traces.dropped, { timeout: 5000 })
      .toBeGreaterThan(0);
    await expect
      .poll(() => getExportStatus().traces.failures.timeout, { timeout: 5000 })
      .toBeGreaterThan(0);

    const status = getExportStatus().traces;
    const rm = await collect(host.reader);
    const dropped = points(rm, METRIC_EXPORT_DROPPED);
    expect(dropped.map((p) => p.attributes)).toEqual([{ signal: "traces" }]);
    expect(dropped[0]?.value).toBeGreaterThanOrEqual(status.dropped);
    const failures = points(rm, METRIC_EXPORT_FAILURES);
    expect(failures.map((p) => p.attributes)).toContainEqual({
      signal: "traces",
      reason: "timeout",
    });
    expect(failures.every((p) => (p.value as number) > 0)).toBe(true);
    await host.provider.shutdown();
  });

  it("#21: log export failures are reported for logs", async () => {
    sink.status["/v1/logs"] = 403;
    await boot({ logs: { export: true }, metrics: false });
    const logger = new NestrixLogger({ colors: false });
    await expect
      .poll(() => getExportStatus().logs.state, { timeout: 5000 })
      .toBe("pending");
    ticker = setInterval(() => logger.log("a line"), 50);
    await expect
      .poll(() => getExportStatus().logs.lastFailure, { timeout: 8000 })
      .toEqual({ reason: "unauthorized", httpStatus: 403 });
    expect(warnings("log records")).toHaveLength(1);
    expect(getExportStatus().traces.state).not.toBe("failing");
    expect(getExportStatus().metrics.state).toBe("inactive");
  });
});
