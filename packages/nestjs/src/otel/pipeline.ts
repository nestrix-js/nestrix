/**
 * The owned export pipeline: OTLP/HTTP exporter, wrapped for redaction, behind a
 * `BatchSpanProcessor`, behind a guarded processor.
 */
import {
  createNoopMeter,
  type Meter,
  type MeterProvider,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BatchSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import { createExportAgents } from "./export-agent.js";
import {
  createRedactingExporter,
  type RedactionCounters,
  settle,
} from "./redacting-exporter.js";
import type { TelemetryConfig, TelemetryDiagnostics } from "./types.js";

export interface PipelineCounters extends RedactionCounters {
  droppedSpans: number;
}

/**
 * The batch processor's self-observability metric (sdk-trace 3.1.1,
 * `export/SpanProcessorMetrics.mjs`): `dropSpans(n)` adds `n` to this counter with
 * `error.type = "queue_full"` (`BatchSpanProcessorBase.mjs:64-68`). Incubating semconv
 * names, so string literals.
 */
const PROCESSED_METRIC = "otel.sdk.processor.span.processed";
const ERROR_TYPE = "error.type";
const QUEUE_FULL = "queue_full";

/**
 * A `MeterProvider` whose only live instrument counts the batch processor's queue-full
 * drops. Passed as `selfObsMeterProvider`, a public (experimental) option of
 * `BatchSpanProcessor`; the drop counter itself (`_droppedSpansCount`) is private and
 * reset after each warning. Every other instrument is the API's no-op.
 */
export function createDropCountingMeterProvider(
  onDropped: (count: number) => void,
): MeterProvider {
  const noop = createNoopMeter();
  const meter: Meter = {
    createCounter(name, options) {
      if (name !== PROCESSED_METRIC) return noop.createCounter(name, options);
      return {
        add(value, attributes) {
          try {
            if (attributes?.[ERROR_TYPE] === QUEUE_FULL) onDropped(value);
          } catch {
            // Counting never throws into the batch processor.
          }
        },
      };
    },
    createGauge: (name, options) => noop.createGauge(name, options),
    createHistogram: (name, options) => noop.createHistogram(name, options),
    createUpDownCounter: (name, options) =>
      noop.createUpDownCounter(name, options),
    createObservableGauge: (name, options) =>
      noop.createObservableGauge(name, options),
    createObservableCounter: (name, options) =>
      noop.createObservableCounter(name, options),
    createObservableUpDownCounter: (name, options) =>
      noop.createObservableUpDownCounter(name, options),
    addBatchObservableCallback: (callback, observables) =>
      noop.addBatchObservableCallback(callback, observables),
    removeBatchObservableCallback: (callback, observables) =>
      noop.removeBatchObservableCallback(callback, observables),
  };
  return { getMeter: () => meter };
}

/**
 * Wraps a processor so no method can throw into the SDK (which does not guard processor
 * calls: `MultiSpanProcessor.mjs`, `Span.mjs:188-191`) and `forceFlush`/`shutdown` never
 * reject. A plain object: no SDK class is extended.
 */
export function guardProcessor(
  inner: SpanProcessor,
  diagnostics: TelemetryDiagnostics,
): SpanProcessor {
  return {
    onStart(span, parentContext) {
      try {
        inner.onStart(span, parentContext);
      } catch (error) {
        diagnostics.countFailure("otel.processor.onStart", error);
      }
    },
    onEnd(span) {
      try {
        inner.onEnd(span);
      } catch (error) {
        diagnostics.countFailure("otel.processor.onEnd", error);
      }
    },
    forceFlush() {
      return settle(() => inner.forceFlush());
    },
    shutdown() {
      return settle(() => inner.shutdown());
    },
  };
}

/**
 * The batch processor's export timeout. It must not fire before the exporter gives up
 * on its own: when it does, the processor rejects the batch, clears its `_isExporting`
 * flag and starts the next batch while the previous request is still retrying; the
 * exporter wrapper then holds that batch, and drops any further one, instead of
 * opening another connection (redacting-exporter.ts). The exporter's retry loop stops
 * scheduling retries at `timeoutMillis` but a last attempt started near the deadline
 * may run up to another `timeoutMillis` (otlp-exporter-base 0.301.1
 * `retrying-transport.mjs:29-42`, `http-transport-utils.mjs:76`).
 */
export function batchExportTimeout(exporterTimeoutMillis: number): number {
  return Math.max(30_000, exporterTimeoutMillis * 2 + 1_000);
}

export interface Pipeline {
  processor: SpanProcessor;
  /**
   * For when the shutdown bound expires: fails pending exports (so the batch processor
   * clears its export timer) and destroys the exporter's sockets with an error it does
   * not retry. A retry backoff timer already scheduled inside the exporter stays.
   */
  abort(): void;
}

/** Builds the pipeline, or returns `undefined` when export is off. */
export function createPipeline(
  config: TelemetryConfig,
  counters: PipelineCounters,
  diagnostics: TelemetryDiagnostics,
): Pipeline | undefined {
  const otlp = config.export.otlp;
  if (otlp === false) return undefined;
  const agents = createExportAgents();
  const exporter: SpanExporter = new OTLPTraceExporter({
    url: otlp.url,
    headers: { ...otlp.headers },
    timeoutMillis: otlp.timeoutMillis,
    httpAgentOptions: (protocol: string) => agents.factory(protocol),
  });
  const chain = createProcessorChain(exporter, {
    scrub: config.scrub,
    redact: config.redact,
    queue: config.export.queue,
    exportTimeoutMillis: batchExportTimeout(otlp.timeoutMillis),
    counters,
    diagnostics,
  });
  return {
    processor: chain.processor,
    abort() {
      chain.abort();
      agents.abort();
    },
  };
}

export interface ProcessorChainOptions {
  scrub: TelemetryConfig["scrub"];
  redact: TelemetryConfig["redact"];
  queue: TelemetryConfig["export"]["queue"];
  /** The batch processor's own export timeout. */
  exportTimeoutMillis: number;
  counters: PipelineCounters;
  diagnostics: TelemetryDiagnostics;
}

/**
 * Everything between the provider and the network exporter: guard, batch processor and
 * redacting, one-in-flight exporter wrapper. Separate from `createPipeline` so tests can
 * put a scripted exporter where the OTLP exporter goes. `abort` fails what is pending.
 */
export function createProcessorChain(
  exporter: SpanExporter,
  options: ProcessorChainOptions,
): Pipeline {
  const { counters, diagnostics, queue } = options;
  const redacting = createRedactingExporter(exporter, {
    scrub: options.scrub,
    redact: options.redact,
    counters,
    diagnostics,
  });
  const batch = new BatchSpanProcessor({
    exporter: redacting,
    maxQueueSize: queue.maxQueueSize,
    maxExportBatchSize: queue.maxExportBatchSize,
    scheduledDelayMillis: queue.scheduledDelayMillis,
    exportTimeoutMillis: options.exportTimeoutMillis,
    selfObsMeterProvider: createDropCountingMeterProvider((count) => {
      counters.droppedSpans += count;
    }),
  });
  // Tells the exporter wrapper when the processor flushes or shuts down, so those exports
  // are not held to one in flight (redacting-exporter.ts). Errors reach guardProcessor.
  const flushAware: SpanProcessor = {
    onStart: (span, parentContext) => batch.onStart(span, parentContext),
    onEnd: (span) => batch.onEnd(span),
    forceFlush: () => redacting.duringFlush(() => batch.forceFlush()),
    shutdown: () => {
      redacting.beginShutdown();
      return batch.shutdown();
    },
  };
  return {
    processor: guardProcessor(flushAware, diagnostics),
    abort: () => redacting.abort(),
  };
}
