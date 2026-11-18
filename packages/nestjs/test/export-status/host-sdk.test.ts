// Global state: a host tracer provider and a host MeterProvider are registered before Nestrix
// starts (D-69). D-82: Nestrix then exports nothing itself, so its export status stays inactive,
// no export-status instrument appears on the host's MeterProvider, and Nestrix sends nothing to the
// configured endpoint. Also: with Nestrix disabled, the status is inactive and reading it works.
import type { INestApplication } from "@nestjs/common";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticsForTests } from "../../src/diagnostics.js";
import { resetExportStatusForTests } from "../../src/export-status.js";
import { getExportStatus } from "../../src/index.js";
import {
  collect,
  hostMeterProvider,
  metricNames,
  metricsModule,
} from "../metrics/fixture.js";
import { bootOwned, sendAll } from "../stats-fixture.js";
import { type StatusSink, startStatusSink } from "./sink.js";

trace.setGlobalTracerProvider(new TracerProvider());
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

let app: INestApplication | undefined;
let sink: StatusSink;
beforeEach(async () => {
  resetDiagnosticsForTests();
  resetExportStatusForTests();
  sink = await startStatusSink();
  sink.status["/v1/traces"] = 401;
  sink.status["/v1/metrics"] = 404;
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  metrics.disable();
  await sink.close();
});

const INACTIVE = {
  state: "inactive",
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailure: null,
  consecutiveFailures: 0,
  dropped: 0,
};

describe("export status with a host-owned SDK", () => {
  it("stays inactive, adds no instrument to the host's MeterProvider and sends nothing", async () => {
    const host = hostMeterProvider();
    metrics.setGlobalMeterProvider(host.provider);
    const onFailure = vi.fn();
    const booted = await bootOwned(
      "node",
      metricsModule({
        logs: { export: true },
        export: {
          otlp: { endpoint: sink.base, timeoutMillis: 500 },
          onFailure,
        },
      }),
    );
    app = booted.app;
    await sendAll(booted.baseUrl, ["/m/ok/1", "/m/ok/2", "/m/ok/3"]);
    await new Promise((r) => setTimeout(r, 300));
    const status = getExportStatus();
    expect(status.degraded).toBe(false);
    expect(status.traces).toMatchObject(INACTIVE);
    expect(status.logs).toMatchObject(INACTIVE);
    expect(status.metrics).toMatchObject(INACTIVE);
    const names = metricNames(await collect(host.reader));
    expect(names).toContain("http.server.request.duration");
    expect(names.filter((n) => n.startsWith("nestrix.export."))).toEqual([]);
    expect(sink.hits).toEqual({});
    // D-110: the host's SDK exports; Nestrix sees none of it, so export.onFailure is never called.
    expect(onFailure).not.toHaveBeenCalled();
    await host.provider.shutdown();
  });

  it("with Nestrix disabled, getExportStatus() is inactive and never throws", async () => {
    const booted = await bootOwned(
      "node",
      metricsModule({
        enabled: false,
        export: { otlp: { endpoint: sink.base } },
      }),
    );
    app = booted.app;
    const status = getExportStatus();
    expect(status.degraded).toBe(false);
    expect(status.traces.state).toBe("inactive");
    expect(status.logs.state).toBe("inactive");
    expect(status.metrics.state).toBe("inactive");
  });
});
