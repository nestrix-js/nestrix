// Global state: Nestrix owns the provider, with the dashboard store on and OTLP export to
// a local receiver. The user's `redact` hook starts and ends a span of its own on every
// span named "work". The store's drain runs the hook under the suppress-tracing key, so
// the helper span is non-recording: not stored, not exported, no feedback loop.
import { trace } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RedactableSpan } from "../src/options.js";
import { setupTelemetry } from "../src/otel/setup.js";
import { getStore } from "../src/store/store.js";
import {
  config,
  otlp,
  type Receiver,
  recordingDiagnostics,
  startReceiver,
} from "./otel-helpers.js";

let receiver: Receiver;
let handle: ReturnType<typeof setupTelemetry>;
const diagnostics = recordingDiagnostics();
const hookCalls: string[] = [];

beforeAll(async () => {
  receiver = await startReceiver();
  handle = setupTelemetry(
    config({
      dashboardStore: { maxTraces: 100, maxBytes: 4 * 1024 * 1024 },
      export: {
        otlp: otlp(receiver.url),
        queue: {
          maxQueueSize: 2048,
          maxExportBatchSize: 512,
          scheduledDelayMillis: 20,
        },
      },
      redact: (span: RedactableSpan) => {
        hookCalls.push(span.name);
        if (span.name === "work")
          trace.getTracer("hook").startSpan("helper").end();
        return undefined;
      },
    }),
    diagnostics,
  );
});

afterAll(async () => {
  await handle.shutdown();
  await receiver.close();
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms),
    ),
  ]);

describe("a redact hook that starts spans", () => {
  it("does not feed the store or the exporter, on the setImmediate drain or on flush", async () => {
    expect(handle.ownsProvider).toBe(true);
    const store = getStore();
    if (!store) throw new Error("no store");
    const tracer = trace.getTracer("app");

    // setImmediate drain: the span is taken in once and nothing follows it. (The hook also
    // runs once per span for the export pipeline, so its call count is not the store's.)
    tracer.startSpan("work").end();
    await tick();
    await tick();
    await tick();
    expect(new Set(hookCalls)).toEqual(new Set(["work"]));
    expect(store.stats()).toMatchObject({ receivedSpans: 1, spans: 1 });

    // drainNow through forceFlush, then shutdown-style drains.
    tracer.startSpan("work").end();
    await within(handle.forceFlush(), 3000);
    expect(new Set(hookCalls)).toEqual(new Set(["work"]));
    expect(store.stats()).toMatchObject({ receivedSpans: 2, spans: 2 });

    const names = store
      .listTraces({ limit: 10 })
      .items.map((t) => store.getTrace(t.traceId)?.spans.map((s) => s.name));
    expect(names.flat()).toEqual(["work", "work"]);

    await receiver.waitForSpans(2);
    await within(handle.forceFlush(), 3000);
    expect(receiver.spans.map((s) => s.name)).toEqual(["work", "work"]);
  });

  it("shuts down promptly", async () => {
    await within(handle.shutdown(), 3000);
    expect(receiver.spans.map((s) => s.name)).not.toContain("helper");
  });
});
