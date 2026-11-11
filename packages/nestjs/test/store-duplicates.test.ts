// Global state: one provider with two nestrixSpanProcessor() instances (a host that added
// it twice). Each span reaches the store twice and must be stored once.
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { afterAll, describe, expect, it } from "vitest";
import { nestrixSpanProcessor } from "../src/store/span-processor.js";
import { getOrCreateStore } from "../src/store/store.js";
import { recordingDiagnostics } from "./otel-helpers.js";

const store = getOrCreateStore({}, recordingDiagnostics());
const detach = store.attach({});
const provider = new TracerProvider({
  spanProcessors: [nestrixSpanProcessor(), nestrixSpanProcessor()],
});
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(provider);

afterAll(async () => {
  detach();
  await provider.shutdown();
});

describe("two nestrixSpanProcessor() on one provider", () => {
  it("stores each span once, with one error item per error", async () => {
    const tracer = trace.getTracer("dup");
    const root = tracer.startSpan("root");
    const ctx = trace.setSpan(context.active(), root);
    const child = tracer.startSpan("child", {}, ctx);
    child.setStatus({ code: 2, message: "boom" });
    child.end();
    root.end();
    await provider.forceFlush();

    expect(store.stats()).toMatchObject({
      processors: 2,
      receivedSpans: 4,
      spans: 2,
      errorItems: 1,
      listedTraces: 1,
    });
    const [item] = store.listTraces({ limit: 5 }).items;
    expect(item?.spanCount).toBe(2);
    expect(store.getTrace(item?.traceId ?? "")?.spans).toHaveLength(2);
    expect(store.listErrors({ limit: 5 }).items).toHaveLength(1);
  });
});
