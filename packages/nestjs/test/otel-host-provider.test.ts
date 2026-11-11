// Global state: the host registered an SDK 3 provider, ALS context manager and W3C
// propagator before Nestrix. Nestrix must build nothing and the host must get the spans.
import {
  context,
  DiagLogLevel,
  diag,
  propagation,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTelemetry } from "../src/otel/setup.js";
import {
  config,
  otlp,
  type Receiver,
  recordingDiagnostics,
  startReceiver,
} from "./otel-helpers.js";

let receiver: Receiver;
const hostExporter = new InMemorySpanExporter();
const hostProvider = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter: hostExporter })],
});
const hostCm = new AsyncLocalStorageContextManager().enable();
const hostPropagator = new W3CTraceContextPropagator();
const diagLines: string[] = [];
// Same module instance as src/otel/setup.ts uses, so this sees the losing provider's shutdown.
const providerShutdown = vi.spyOn(TracerProvider.prototype, "shutdown");
const duplicateLines = () =>
  diagLines.filter((l) => l.includes("Attempted duplicate registration"));

beforeAll(async () => {
  receiver = await startReceiver();
  diag.setLogger(
    {
      error: (m) => diagLines.push(`error ${m}`),
      warn: (m) => diagLines.push(`warn ${m}`),
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    DiagLogLevel.WARN,
  );
  expect(trace.setGlobalTracerProvider(hostProvider)).toBe(true);
  expect(context.setGlobalContextManager(hostCm)).toBe(true);
  expect(propagation.setGlobalPropagator(hostPropagator)).toBe(true);
});
afterAll(async () => {
  await receiver.close();
});

describe("host SDK registered first", () => {
  const diagnostics = recordingDiagnostics();
  let handle: ReturnType<typeof setupTelemetry>;

  it("Nestrix owns nothing, registers nothing and logs once", () => {
    handle = setupTelemetry(
      config({
        sampleRate: 0,
        export: {
          otlp: otlp(receiver.url),
          queue: {
            maxQueueSize: 10,
            maxExportBatchSize: 5,
            scheduledDelayMillis: 10,
          },
        },
      }),
      diagnostics,
    );
    expect(handle.ownsProvider).toBe(false);
    expect(handle.registered).toEqual({
      tracerProvider: false,
      contextManager: false,
      propagator: false,
    });
    expect(diagnostics.logs.get("otel.host-provider")).toMatch(
      /already registered/,
    );
    expect(diagnostics.logs.has("otel.host-no-context-manager")).toBe(false);
    expect(diagnostics.logs.has("otel.host-no-propagator")).toBe(false);
    expect(diagnostics.failures).toEqual([]);
  });

  it("writes exactly one duplicate-registration line to the host's diag logger (the accepted cost)", () => {
    const dup = diagLines.filter((l) =>
      l.includes("Attempted duplicate registration"),
    );
    expect(dup).toHaveLength(1);
    expect(dup[0]).toContain("API: trace");
  });

  it("API spans land in the host exporter, parented, and not in Nestrix's receiver", async () => {
    const tracer = trace.getTracer("otel-host-test");
    await tracer.startActiveSpan("host-parent", async (parent) => {
      await new Promise((r) => setTimeout(r, 5));
      tracer.startSpan("host-child").end();
      parent.end();
    });
    const spans = hostExporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "host-parent");
    const child = spans.find((s) => s.name === "host-child");
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
    // sampleRate: 0 was ignored, because the host's sampler decides.
    expect(spans).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 100));
    expect(receiver.posts).toBe(0);
  });

  it("shutdown leaves the host provider and globals alone", async () => {
    await handle.shutdown();
    hostExporter.reset();
    trace.getTracer("otel-host-test").startSpan("after-shutdown").end();
    expect(hostExporter.getFinishedSpans().map((s) => s.name)).toEqual([
      "after-shutdown",
    ]);
    expect([...propagation.fields()]).toEqual(["traceparent", "tracestate"]);
    expect(await handle.forceFlush()).toBeUndefined();
  });

  it("the provider that lost the race was shut down, and the host's was not", () => {
    expect(providerShutdown).toHaveBeenCalledTimes(1);
    expect(providerShutdown.mock.contexts[0]).not.toBe(hostProvider);
  });

  it("later app lifecycles do not retry the registration: still one diag line, no provider built", async () => {
    for (let i = 0; i < 4; i++) {
      const h = setupTelemetry(config(), recordingDiagnostics());
      expect(h.ownsProvider).toBe(false);
      await h.shutdown();
    }
    expect(duplicateLines()).toHaveLength(1);
    expect(providerShutdown).toHaveBeenCalledTimes(1);
  });

  it("a host that disables and re-registers costs one more try and one more line", async () => {
    trace.disable();
    const host2 = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter: hostExporter })],
    });
    expect(trace.setGlobalTracerProvider(host2)).toBe(true);
    const h = setupTelemetry(config(), recordingDiagnostics());
    expect(h.ownsProvider).toBe(false);
    expect(duplicateLines()).toHaveLength(2);
    const again = setupTelemetry(config(), recordingDiagnostics());
    expect(again.ownsProvider).toBe(false);
    expect(duplicateLines()).toHaveLength(2);
  });
});
