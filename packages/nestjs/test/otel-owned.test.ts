// Global state: no host SDK. Nestrix owns the provider, context manager and propagator.
import {
  context,
  createContextKey,
  propagation,
  ROOT_CONTEXT,
  trace,
} from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasContextManager, hasPropagator } from "../src/otel/detect.js";
import { setupTelemetry } from "../src/otel/setup.js";
import type { TelemetryHandle } from "../src/otel/types.js";
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

describe("Nestrix owns the provider", () => {
  let handle: TelemetryHandle;
  const diagnostics = recordingDiagnostics();

  it("starts with nothing registered", () => {
    expect(hasContextManager()).toBe(false);
    expect(hasPropagator()).toBe(false);
  });

  it("registers provider, ALS context manager and W3C propagator", () => {
    handle = setupTelemetry(
      config({
        serviceName: "svc-option",
        resourceAttributes: {
          "deployment.environment.name": "test",
          team: "core",
        },
        otelResourceAttributes:
          "team=from-env,region=eu%2Cwest,service.name=svc-env",
        export: {
          otlp: otlp(receiver.url),
          queue: {
            maxQueueSize: 100,
            maxExportBatchSize: 10,
            scheduledDelayMillis: 20,
          },
        },
      }),
      diagnostics,
    );
    expect(handle.ownsProvider).toBe(true);
    expect(handle.registered).toEqual({
      tracerProvider: true,
      contextManager: true,
      propagator: true,
    });
    expect(hasContextManager()).toBe(true);
    expect([...propagation.fields()]).toEqual(["traceparent", "tracestate"]);
    expect(diagnostics.failures).toEqual([]);
    expect(diagnostics.logs.has("otel.export-off")).toBe(false);
  });

  it("exports parented spans with the resource to the OTLP receiver", async () => {
    const tracer = trace.getTracer("otel-owned-test");
    await tracer.startActiveSpan("parent", async (parent) => {
      await new Promise((r) => setTimeout(r, 5));
      tracer.startSpan("child").end();
      parent.end();
    });
    const spans = await receiver.waitForSpans(2);
    const parent = spans.find((s) => s.name === "parent");
    const child = spans.find((s) => s.name === "child");
    expect(parent).toBeDefined();
    expect(child?.parentSpanId).toBe(parent?.spanId);
    expect(child?.traceId).toBe(parent?.traceId);
    // Precedence: serviceName > resourceAttributes > OTEL_RESOURCE_ATTRIBUTES > defaults.
    expect(parent?.resource).toMatchObject({
      "service.name": "svc-option",
      team: "core",
      region: "eu,west",
      "deployment.environment.name": "test",
      "telemetry.sdk.language": "nodejs",
    });
    // The receiver parses the request before the exporter reads the response.
    await expect.poll(() => handle.counters.exportedSpans).toBe(2);
    expect(receiver.posts).toBeGreaterThanOrEqual(1);
  });

  it("injects and extracts traceparent through the registered propagator", () => {
    const tracer = trace.getTracer("otel-owned-test");
    const span = tracer.startSpan("prop");
    const carrier: Record<string, string> = {};
    propagation.inject(trace.setSpan(ROOT_CONTEXT, span), carrier);
    span.end();
    expect(carrier.traceparent).toMatch(
      new RegExp(
        `^00-${span.spanContext().traceId}-${span.spanContext().spanId}-01$`,
      ),
    );
    const extracted = propagation.extract(ROOT_CONTEXT, carrier);
    expect(trace.getSpanContext(extracted)?.traceId).toBe(
      span.spanContext().traceId,
    );
  });

  it("shutdown flushes spans still in the queue", async () => {
    await handle.shutdown();
    receiver.spans.length = 0;
    // A long delay keeps these in the batch processor's queue until shutdown.
    const h2 = setupTelemetry(
      config({
        export: {
          otlp: otlp(receiver.url),
          queue: {
            maxQueueSize: 100,
            maxExportBatchSize: 50,
            scheduledDelayMillis: 60_000,
          },
        },
      }),
      diagnostics,
    );
    expect(h2.ownsProvider).toBe(true);
    const tracer = trace.getTracer("otel-owned-test");
    for (let i = 0; i < 5; i++) tracer.startSpan(`buffered-${i}`).end();
    await new Promise((r) => setTimeout(r, 100));
    expect(receiver.spans).toHaveLength(0);
    await h2.shutdown();
    expect(receiver.spans.map((s) => s.name).sort()).toEqual([
      "buffered-0",
      "buffered-1",
      "buffered-2",
      "buffered-3",
      "buffered-4",
    ]);
    // Idempotent and never rejects.
    await expect(h2.shutdown()).resolves.toBeUndefined();
  });

  it("removes its globals on shutdown, so a later app can own them again", () => {
    expect(hasContextManager()).toBe(false);
    expect(hasPropagator()).toBe(false);
    expect(trace.getTracer("x").startSpan("after").isRecording()).toBe(false);
    const again = setupTelemetry(config(), recordingDiagnostics());
    expect(again.ownsProvider).toBe(true);
    expect(trace.getTracer("x").startSpan("again").isRecording()).toBe(true);
    return again.shutdown();
  });

  it("two apps share the owned provider: closing the first keeps the second working, the last removes the globals", async () => {
    const tracer = () => trace.getTracer("two-apps");
    const k = createContextKey("two-apps");
    const contextWorks = () =>
      context.with(ROOT_CONTEXT.setValue(k, 1), () =>
        context.active().getValue(k),
      ) === 1;
    for (const closeFirstOwnerFirst of [true, false]) {
      receiver.spans.length = 0;
      const d1 = recordingDiagnostics();
      const d2 = recordingDiagnostics();
      const a = setupTelemetry(
        config({
          export: {
            otlp: otlp(receiver.url),
            queue: {
              maxQueueSize: 100,
              maxExportBatchSize: 50,
              scheduledDelayMillis: 60_000,
            },
          },
        }),
        d1,
      );
      const b = setupTelemetry(config(), d2);
      expect(a.ownsProvider).toBe(true);
      expect(b.ownsProvider).toBe(true);
      expect(a.registered).toEqual({
        tracerProvider: true,
        contextManager: true,
        propagator: true,
      });
      expect(b.registered).toEqual({
        tracerProvider: false,
        contextManager: false,
        propagator: false,
      });
      expect(b.counters).toBe(a.counters);
      expect(d2.logs.has("otel.second-instance")).toBe(true);
      expect(d2.logs.has("otel.host-provider")).toBe(false);

      const [early, late] = closeFirstOwnerFirst ? [a, b] : [b, a];
      tracer().startSpan("before-first-close").end();
      await early.shutdown();
      // Flushed, not torn down.
      expect(receiver.spans.map((s) => s.name)).toEqual(["before-first-close"]);
      expect(tracer().startSpan("probe").isRecording()).toBe(true);
      expect(contextWorks()).toBe(true);
      expect(hasPropagator()).toBe(true);
      // Idempotent: a second shutdown of the same handle does not count twice.
      await early.shutdown();
      expect(tracer().startSpan("probe").isRecording()).toBe(true);

      tracer().startSpan("before-last-close").end();
      await late.shutdown();
      expect(receiver.spans.map((s) => s.name)).toContain("before-last-close");
      expect(tracer().startSpan("probe").isRecording()).toBe(false);
      expect(contextWorks()).toBe(false);
      expect(hasPropagator()).toBe(false);
    }
  });

  it("with export off, owns the provider and says once that nothing is exported", async () => {
    const d = recordingDiagnostics();
    const h = setupTelemetry(config(), d);
    expect(h.ownsProvider).toBe(true);
    expect(d.logs.get("otel.export-off")).toMatch(/OTLP export is off/);
    // Context still propagates, so traceparent works without export.
    const span = trace.getTracer("x").startSpan("no-export");
    expect(
      context.with(
        trace.setSpan(context.active(), span),
        () => trace.getActiveSpan()?.spanContext().spanId,
      ),
    ).toBe(span.spanContext().spanId);
    span.end();
    await h.shutdown();
  });
});
