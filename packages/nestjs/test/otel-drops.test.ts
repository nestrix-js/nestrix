// Global state: Nestrix owns the provider; the OTLP endpoint refuses connections.
import { trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { setupTelemetry } from "../src/otel/setup.js";
import {
  config,
  otlp,
  recordingDiagnostics,
  unreachableUrl,
} from "./otel-helpers.js";

describe("unreachable endpoint, small queue", () => {
  it("drops and counts what does not fit, and shutdown cuts off the retrying export at its bound", async () => {
    const diagnostics = recordingDiagnostics();
    const handle = setupTelemetry(
      config({
        export: {
          // Exporter deadline far above the shutdown bound: it is still retrying
          // ECONNREFUSED when shutdown starts.
          otlp: otlp(await unreachableUrl(), 10_000),
          queue: {
            maxQueueSize: 4,
            maxExportBatchSize: 2,
            scheduledDelayMillis: 10,
          },
        },
        shutdownTimeoutMillis: 600,
      }),
      diagnostics,
    );
    expect(handle.ownsProvider).toBe(true);

    const tracer = trace.getTracer("drops");
    for (let i = 0; i < 50; i++) tracer.startSpan(`s-${i}`).end();
    // BatchSpanProcessor (sdk-trace 3.1.1): the second span reaches maxExportBatchSize,
    // so one batch of 2 leaves the queue for the exporter at once and the processor is
    // "exporting" until it settles. The next 4 fill the queue; the other 44 are dropped.
    expect(handle.counters.droppedSpans).toBe(44);

    // More spans while the first export retries: still bounded by the queue.
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 1000; i++) tracer.startSpan(`late-${i}`).end();
    expect(handle.counters.droppedSpans).toBe(44 + 1000);
    expect(handle.counters.exportFailedSpans).toBe(0);

    const started = Date.now();
    await handle.shutdown();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(550);
    expect(took).toBeLessThan(600 + 400);
    // The retrying batch (2) and the queue flushed at shutdown (4) were failed by abort().
    expect(handle.counters.exportFailedSpans).toBe(6);
    expect(handle.counters.exportedSpans).toBe(0);
    expect(diagnostics.logs.has("otel.shutdown-timeout")).toBe(true);
    expect(diagnostics.failures).toEqual([]);
  });
});
