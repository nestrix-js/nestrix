/**
 * `@nestrix-js/nestjs/testing`: finished spans in memory, for the tests of an app that uses
 * Nestrix. Setup code (architecture rule 5), so it may import the SDK; the instrumentation
 * code in the rest of the package does not.
 *
 * Nestrix registers no hook for extra span processors on a provider it owns. The supported
 * route for an extra processor is the host-owned one (README, "Your own SDK"): this module
 * registers a tracer provider with an in-memory exporter, plus the context manager and the
 * propagator Nestrix would otherwise register, before the app is created. Nestrix then
 * reports through that provider. Call it before `NestFactory.create` or `Test.createTestingModule`.
 */
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

export type { ReadableSpan };

export interface InMemorySpanCapture {
  /** Spans finished since the last `reset()`, oldest first. */
  spans(): ReadableSpan[];
  /** The first finished span with that name, or the first one the predicate accepts. */
  findSpan(
    match: string | ((span: ReadableSpan) => boolean),
  ): ReadableSpan | undefined;
  /** Forgets the spans captured so far. */
  reset(): void;
  /** Unregisters the globals this capture registered and shuts its provider down. Idempotent. */
  shutdown(): Promise<void>;
}

/**
 * Captures finished spans for one test file. OpenTelemetry's globals are per process, so only
 * one capture can be active at a time; call `shutdown()` in `afterAll`.
 */
export function createInMemorySpanCapture(): InMemorySpanCapture {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  if (!trace.setGlobalTracerProvider(provider)) {
    void provider.shutdown();
    throw new Error(
      "@nestrix-js/nestjs/testing: a tracer provider is already registered in this process, so spans would not reach the capture. Call createInMemorySpanCapture() before the Nest app is created, once per test file, and shutdown() the previous capture first.",
    );
  }
  let contextManager: AsyncLocalStorageContextManager | undefined;
  let contextRegistered = false;
  let propagatorRegistered = false;
  try {
    contextManager = new AsyncLocalStorageContextManager().enable();
    contextRegistered = context.setGlobalContextManager(contextManager);
    if (!contextRegistered) contextManager.disable();
    propagatorRegistered = propagation.setGlobalPropagator(
      new W3CTraceContextPropagator(),
    );
  } catch {
    // A missing context manager only loses parenting across awaits; the capture still works.
  }
  let closed = false;
  return {
    spans: () => exporter.getFinishedSpans(),
    findSpan(match) {
      const accepts =
        typeof match === "string"
          ? (span: ReadableSpan) => span.name === match
          : match;
      return exporter.getFinishedSpans().find(accepts);
    },
    reset: () => exporter.reset(),
    async shutdown() {
      if (closed) return;
      closed = true;
      trace.disable();
      if (contextRegistered) context.disable();
      if (propagatorRegistered) propagation.disable();
      await provider.shutdown();
      exporter.reset();
    },
  };
}
