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
  it("drops and counts what does not fit, fails the in-flight batch, and shuts down within its bound", async () => {
    const diagnostics = recordingDiagnostics();
    const handle = setupTelemetry(
      config({
        export: {
          otlp: otlp(await unreachableUrl(), 300),
          queue: {
            maxQueueSize: 4,
            maxExportBatchSize: 2,
            scheduledDelayMillis: 10,
          },
        },
        shutdownTimeoutMillis: 1500,
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

    // ECONNREFUSED is retryable; the exporter retries until its 300 ms deadline, then
    // reports failure for the batch.
    const deadline = Date.now() + 5000;
    while (handle.counters.exportFailedSpans < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(handle.counters.exportFailedSpans).toBeGreaterThanOrEqual(2);
    expect(handle.counters.exportedSpans).toBe(0);

    // More spans after the outage starts: still bounded by the queue.
    for (let i = 0; i < 1000; i++) tracer.startSpan(`late-${i}`).end();
    expect(handle.counters.droppedSpans).toBeGreaterThanOrEqual(
      44 + 1000 - 4 - 2,
    );

    const started = Date.now();
    await handle.shutdown();
    const took = Date.now() - started;
    expect(took).toBeLessThan(1500 + 500);
    expect(diagnostics.failures).toEqual([]);
  });
});
