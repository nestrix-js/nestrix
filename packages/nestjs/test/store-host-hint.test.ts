// Global state: the host registered its own SDK 3 provider without nestrixSpanProcessor().
// With the dashboard on, Nestrix adds nothing to the host's provider and logs one hint.
import { trace } from "@opentelemetry/api";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";
import { setupTelemetry } from "../src/otel/setup.js";
import { config, recordingDiagnostics } from "./otel-helpers.js";

trace.setGlobalTracerProvider(new TracerProvider());

describe("host-owned provider without nestrixSpanProcessor()", () => {
  it("logs nothing about the store when the dashboard is off", async () => {
    const diagnostics = recordingDiagnostics();
    const handle = setupTelemetry(config(), diagnostics);
    expect(handle.store).toBeUndefined();
    expect(diagnostics.logs.has("store.host-processor-hint")).toBe(false);
    await handle.shutdown();
  });

  it("with the dashboard on, logs one hint naming nestrixSpanProcessor() and stores nothing", async () => {
    const diagnostics = recordingDiagnostics();
    const dashboardStore = { maxTraces: 10, maxBytes: 1_000_000 };
    const first = setupTelemetry(config({ dashboardStore }), diagnostics);
    const second = setupTelemetry(config({ dashboardStore }), diagnostics);
    expect(diagnostics.logs.get("store.host-processor-hint")).toContain(
      "nestrixSpanProcessor()",
    );
    expect(diagnostics.logs.size).toBeGreaterThan(0);
    trace.getTracer("host").startSpan("unseen").end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(first.store?.stats()).toMatchObject({
      receivedSpans: 0,
      attached: 2,
    });
    await first.shutdown();
    await second.shutdown();
    expect(first.store?.stats().attached).toBe(0);
    expect(diagnostics.failures).toEqual([]);
  });
});
