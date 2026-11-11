// An ESM host's own OpenTelemetry SDK 3 setup, as it would sit in its instrument file.
// SDK 3's TracerProvider has no register(), so the host registers the provider, an
// AsyncLocalStorage context manager and the W3C propagator through the API itself.

import * as api from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import * as sdk from "@opentelemetry/sdk-trace";

export function setupHost(options = {}) {
  const exporter = new sdk.InMemorySpanExporter();
  const provider = new sdk.TracerProvider({
    sampler: options.sampler === "off" ? new sdk.AlwaysOffSampler() : undefined,
    spanProcessors: [
      new sdk.SimpleSpanProcessor({ exporter }),
      ...(options.extraProcessors ?? []),
    ],
  });
  const registered = {
    provider: api.trace.setGlobalTracerProvider(provider),
    contextManager:
      options.contextManager === false
        ? null
        : api.context.setGlobalContextManager(
            new AsyncLocalStorageContextManager().enable(),
          ),
    propagator:
      options.propagator === false
        ? null
        : api.propagation.setGlobalPropagator(new W3CTraceContextPropagator()),
  };
  return {
    api,
    sdk,
    exporter,
    provider,
    registered,
    apiFile: import.meta.resolve("@opentelemetry/api"),
  };
}
