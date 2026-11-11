// A CommonJS host's own OpenTelemetry SDK 3 setup. Everything here comes from the
// .cjs builds of the API and SDK, the copies a CommonJS app really gets.

const api = require("@opentelemetry/api");
const {
  AsyncLocalStorageContextManager,
} = require("@opentelemetry/context-async-hooks");
const { W3CTraceContextPropagator } = require("@opentelemetry/core");
const sdk = require("@opentelemetry/sdk-trace");

function setupHost(options = {}) {
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
    apiFile: require.resolve("@opentelemetry/api"),
  };
}

module.exports = { setupHost };
