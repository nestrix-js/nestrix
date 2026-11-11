import type { AsyncLocalStorage } from "node:async_hooks";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

export interface TracingSetup {
  exporter: InMemorySpanExporter;
  provider: TracerProvider;
  registered: {
    provider: boolean;
    contextManager: boolean;
    propagator: boolean;
  };
}

let setup: TracingSetup | undefined;

/**
 * The SDK half (setup code only, rule 5). SDK 3's `@opentelemetry/sdk-trace` has no
 * `register()` and ships only `StackContextManager`, so the context manager is
 * `AsyncLocalStorageContextManager` from `@opentelemetry/context-async-hooks` 3.1.1
 * (peer `@opentelemetry/api >=1.0.0 <1.11.0`).
 */
export function setupTracing(): TracingSetup {
  if (setup) return setup;
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  setup = {
    exporter,
    provider,
    registered: {
      contextManager: context.setGlobalContextManager(contextManager),
      provider: trace.setGlobalTracerProvider(provider),
      propagator: propagation.setGlobalPropagator(
        new W3CTraceContextPropagator(),
      ),
    },
  };
  storage = (
    contextManager as unknown as {
      _asyncLocalStorage: AsyncLocalStorage<unknown>;
    }
  )._asyncLocalStorage;
  return setup;
}

let storage: AsyncLocalStorage<unknown> | undefined;

/**
 * Spike only (review F4): the AsyncLocalStorage behind the context manager we
 * registered, read from a private field. A production version would own its context
 * manager class instead.
 */
export function contextStorage(): AsyncLocalStorage<unknown> | undefined {
  return storage;
}

export interface SpanRecord {
  name: string;
  kind: number;
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
  events: string[];
  startMs: number;
  endMs: number;
}

function hrToMs(t: [number, number]): number {
  return t[0] * 1000 + t[1] / 1e6;
}

export function toRecord(s: ReadableSpan): SpanRecord {
  return {
    name: s.name,
    kind: s.kind,
    traceId: s.spanContext().traceId,
    spanId: s.spanContext().spanId,
    parentSpanId: s.parentSpanContext?.spanId,
    attributes: { ...s.attributes },
    status: { code: s.status.code, message: s.status.message },
    events: s.events.map((e) => e.name),
    startMs: hrToMs(s.startTime),
    endMs: hrToMs(s.endTime),
  };
}

export function finishedSpans(): SpanRecord[] {
  return setup ? setup.exporter.getFinishedSpans().map(toRecord) : [];
}

export function resetSpans(): void {
  setup?.exporter.reset();
}
