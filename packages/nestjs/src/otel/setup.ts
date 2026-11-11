/**
 * OpenTelemetry setup. SDK packages are imported under `src/otel/` only (AGENTS.md
 * rule 5). Nothing happens at import time; `setupTelemetry` is
 * called from `NestrixCore`'s constructor (architecture §4.2 "Registration timing").
 *
 * Provider ownership (architecture §4.5): Nestrix calls `trace.setGlobalTracerProvider`
 * and accepts its answer. `false` means something else owns the provider; Nestrix then
 * builds nothing more and its instrumentation reports through the host's SDK.
 */
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import {
  contextSurvivesAwait,
  hasContextManager,
  hasPropagator,
} from "./detect.js";
import { createPipeline, type PipelineCounters } from "./pipeline.js";
import { settle } from "./redacting-exporter.js";
import { buildResource } from "./resource.js";
import type {
  TelemetryConfig,
  TelemetryDiagnostics,
  TelemetryHandle,
} from "./types.js";

const DEFAULT_SHUTDOWN_TIMEOUT_MILLIS = 5_000;

/**
 * Set while a provider this module registered is still the global one. A second
 * `setupTelemetry` in the same process (two apps open at once) then gets `false` from
 * the API for Nestrix's own provider, not a host's; the log line says which.
 */
let ownedByNestrix = false;

function newCounters(): PipelineCounters {
  return {
    droppedSpans: 0,
    exportedSpans: 0,
    exportFailedSpans: 0,
    redactDroppedSpans: 0,
    redactFailedSpans: 0,
  };
}

function inertHandle(counters: PipelineCounters): TelemetryHandle {
  return {
    ownsProvider: false,
    registered: {
      tracerProvider: false,
      contextManager: false,
      propagator: false,
    },
    counters,
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

/** Resolves after `ms` without keeping the process alive. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Registers Nestrix's OpenTelemetry pipeline, or steps aside for a host's. Never throws:
 * a failure is counted and the returned handle is inert.
 */
export function setupTelemetry(
  config: TelemetryConfig,
  diagnostics: TelemetryDiagnostics,
): TelemetryHandle {
  const counters = newCounters();
  try {
    return setup(config, diagnostics, counters);
  } catch (error) {
    diagnostics.countFailure("otel.setup", error);
    return inertHandle(counters);
  }
}

function setup(
  config: TelemetryConfig,
  diagnostics: TelemetryDiagnostics,
  counters: PipelineCounters,
): TelemetryHandle {
  if (ownedByNestrix) {
    diagnostics.logOnce(
      "otel.second-instance",
      "Another Nestrix instance in this process already owns the OpenTelemetry tracer provider; this one reports through it, with that instance's export settings.",
    );
    return inertHandle(counters);
  }

  // Built before registering, because SDK 3's TracerProvider takes processors only in
  // its constructor. Everything here belongs to this provider alone, so shutting it
  // down after a lost race touches nothing of the host's (architecture §4.5).
  const pipeline = createPipeline(config, counters, diagnostics);
  const provider = new TracerProvider({
    resource: buildResource(config, () =>
      diagnostics.logOnce(
        "otel.resource-env-invalid",
        "OTEL_RESOURCE_ATTRIBUTES is malformed and was ignored as a whole (expected key=value pairs separated by commas, with ',' and '=' percent-encoded).",
      ),
    ),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.sampleRate),
    }),
    spanProcessors: pipeline ? [pipeline.processor] : [],
  });

  // When a host provider exists this writes one "Attempted duplicate registration of
  // API: trace" error, with a stack, to the host's diag logger (if it set one). There
  // is no silent public probe for a provider; see architecture §4.5.
  if (!trace.setGlobalTracerProvider(provider)) {
    void settle(() => provider.shutdown());
    diagnostics.logOnce(
      "otel.host-provider",
      "An OpenTelemetry tracer provider is already registered, so Nestrix uses it: Nestrix's spans go to that SDK's exporters, and Nestrix's export, sampleRate, resource and redact options are ignored.",
    );
    if (!hasContextManager()) {
      diagnostics.logOnce(
        "otel.host-no-context-manager",
        "The registered OpenTelemetry SDK has no context manager, so spans will not be parented across calls. Register one (for example AsyncLocalStorageContextManager from @opentelemetry/context-async-hooks) with context.setGlobalContextManager().",
      );
    }
    if (!hasPropagator()) {
      diagnostics.logOnce(
        "otel.host-no-propagator",
        "The registered OpenTelemetry SDK has no propagator, so no traceparent is read or sent. Register one (for example W3CTraceContextPropagator from @opentelemetry/core) with propagation.setGlobalPropagator().",
      );
    }
    return inertHandle(counters);
  }
  ownedByNestrix = true;

  if (!pipeline) {
    diagnostics.logOnce(
      "otel.export-off",
      "OTLP export is off: no endpoint is set (export.otlp.endpoint, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT), or export.otlp is false. Spans are created but not sent anywhere.",
    );
  }

  const registered = {
    tracerProvider: true,
    contextManager: false,
    propagator: false,
  };
  let contextManager: AsyncLocalStorageContextManager | undefined;
  try {
    if (hasContextManager()) {
      warnIfContextIsSyncOnly(diagnostics);
    } else {
      const manager = new AsyncLocalStorageContextManager().enable();
      if (context.setGlobalContextManager(manager)) {
        registered.contextManager = true;
        contextManager = manager;
      } else {
        manager.disable();
      }
    }
  } catch (error) {
    diagnostics.countFailure("otel.context-manager", error);
  }
  try {
    if (!hasPropagator()) {
      registered.propagator = propagation.setGlobalPropagator(
        new W3CTraceContextPropagator(),
      );
    }
  } catch (error) {
    diagnostics.countFailure("otel.propagator", error);
  }

  const timeoutMillis =
    config.shutdownTimeoutMillis ?? DEFAULT_SHUTDOWN_TIMEOUT_MILLIS;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = async (): Promise<void> => {
    let timedOut = false;
    try {
      // New spans become no-ops from here on; spans already queued are still exported.
      trace.disable();
    } catch (error) {
      diagnostics.countFailure("otel.shutdown", error);
    }
    ownedByNestrix = false;
    await Promise.race([
      settle(() => provider.shutdown()),
      delay(timeoutMillis).then(() => {
        timedOut = true;
      }),
    ]);
    if (timedOut) {
      diagnostics.logOnce(
        "otel.shutdown-timeout",
        `Flushing spans on shutdown took longer than ${timeoutMillis} ms; the rest were dropped.`,
      );
    }
    // Last, so the exporter's in-flight requests kept their suppressed context.
    try {
      if (registered.contextManager && contextManager) context.disable();
    } catch (error) {
      diagnostics.countFailure("otel.shutdown", error);
    }
    try {
      if (registered.propagator) propagation.disable();
    } catch (error) {
      diagnostics.countFailure("otel.shutdown", error);
    }
  };

  return {
    ownsProvider: true,
    registered,
    counters,
    forceFlush: () =>
      shutdownPromise
        ? Promise.resolve()
        : settle(() => provider.forceFlush({ timeoutMillis })),
    shutdown: () => {
      shutdownPromise ??= settle(shutdown);
      return shutdownPromise;
    },
  };
}

/**
 * A context manager is registered but may be sync-only (`StackContextManager`): its slot
 * is taken and cannot be replaced, so all Nestrix can do is say so. Fire and forget.
 */
function warnIfContextIsSyncOnly(diagnostics: TelemetryDiagnostics): void {
  contextSurvivesAwait().then(
    (survives) => {
      try {
        if (survives) return;
        diagnostics.logOnce(
          "otel.context-sync-only",
          "The registered OpenTelemetry context manager does not carry context across await, so spans after an await lose their parent. Register AsyncLocalStorageContextManager from @opentelemetry/context-async-hooks instead.",
        );
      } catch {
        // Never an unhandled rejection.
      }
    },
    () => undefined,
  );
}
