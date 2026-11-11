// Global state: Nestrix owns the provider with sampleRate 0.
import { propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTelemetry } from "../src/otel/setup.js";
import {
  config,
  otlp,
  type Receiver,
  recordingDiagnostics,
  startReceiver,
} from "./otel-helpers.js";

let receiver: Receiver;
beforeAll(async () => {
  receiver = await startReceiver();
});
afterAll(async () => {
  await receiver.close();
});

describe("sampleRate: 0", () => {
  it("exports no root span, and still honours a sampled incoming parent (ParentBased)", async () => {
    const handle = setupTelemetry(
      config({
        sampleRate: 0,
        export: {
          otlp: otlp(receiver.url),
          queue: {
            maxQueueSize: 100,
            maxExportBatchSize: 10,
            scheduledDelayMillis: 10,
          },
        },
      }),
      recordingDiagnostics(),
    );
    expect(handle.ownsProvider).toBe(true);
    const tracer = trace.getTracer("sample-zero");
    for (let i = 0; i < 50; i++) {
      const span = tracer.startSpan(`root-${i}`);
      expect(span.isRecording()).toBe(false);
      span.end();
    }
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const sampledParent = propagation.extract(ROOT_CONTEXT, {
      traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
    });
    tracer.startSpan("child-of-sampled", {}, sampledParent).end();
    const unsampledParent = propagation.extract(ROOT_CONTEXT, {
      traceparent: `00-${traceId}-00f067aa0ba902b7-00`,
    });
    tracer.startSpan("child-of-unsampled", {}, unsampledParent).end();

    await handle.shutdown();
    expect(receiver.spans.map((s) => s.name)).toEqual(["child-of-sampled"]);
    expect(receiver.spans[0]?.traceId).toBe(traceId);
    await expect.poll(() => handle.counters.exportedSpans).toBe(1);
  });
});
