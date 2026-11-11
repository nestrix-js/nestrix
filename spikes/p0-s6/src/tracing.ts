// Test-only OpenTelemetry setup (SDK packages are fine here; the wrapper itself imports the API only).
// One provider per process; Vitest gives each test file its own worker.
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

let exporter: InMemorySpanExporter | undefined;

export function setupTracing(): InMemorySpanExporter {
  if (exporter) return exporter;
  exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  const cm = new AsyncLocalStorageContextManager();
  cm.enable();
  if (!context.setGlobalContextManager(cm))
    throw new Error("context manager already set");
  if (!trace.setGlobalTracerProvider(provider))
    throw new Error("tracer provider already set");
  return exporter;
}

export function spanNames(spans: ReadableSpan[]): string[] {
  return spans.map((s) => s.name);
}

export type { ReadableSpan };
