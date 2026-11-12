/**
 * OpenTelemetry setup. SDK packages are imported under `src/otel/` only (AGENTS.md
 * rule 5). Nothing happens at import time; `setupTelemetry` is called from
 * `NestrixCore`'s constructor (architecture §4.2 "Registration timing").
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
import { createStoreProcessor } from "../store/processor.js";
import { getOrCreateStore, type TraceStore } from "../store/store.js";
import {
  contextSurvivesAwait,
  hasContextManager,
  hasPropagator,
} from "./detect.js";
import {
  createPipeline,
  type Pipeline,
  type PipelineCounters,
  spanProcessors,
} from "./pipeline.js";
import { settle } from "./redacting-exporter.js";
import { buildResource } from "./resource.js";
import type {
  TelemetryConfig,
  TelemetryDiagnostics,
  TelemetryHandle,
} from "./types.js";

const DEFAULT_SHUTDOWN_TIMEOUT_MILLIS = 5_000;

/** The provider Nestrix registered, shared by every app in the process that set up while it was open. */
interface Owned {
  provider: TracerProvider;
  pipeline: Pipeline | undefined;
  /** The dashboard store fed by this provider's store processor, when the first app had the dashboard on. */
  store: TraceStore | undefined;
  counters: PipelineCounters;
  contextManagerRegistered: boolean;
  propagatorRegistered: boolean;
  timeoutMillis: number;
  diagnostics: TelemetryDiagnostics;
  /** Open handles. Only the last one to shut down tears the provider down. */
  refs: number;
}

let owned: Owned | undefined;

/**
 * What `trace.getTracerProvider()` returned right after a lost registration. While it
 * returns the same object the host's provider is still registered, so Nestrix does not
 * try again: each try writes a "duplicate registration" error to the host's diag logger.
 * A host that disables and re-registers gets a new object (api 1.10.0 `trace.disable()`
 * replaces the proxy), and costs one more try and one more line.
 */
let lostTo: unknown;

function newCounters(): PipelineCounters {
  return {
    droppedSpans: 0,
    exportedSpans: 0,
    exportFailedSpans: 0,
    redactDroppedSpans: 0,
    redactFailedSpans: 0,
  };
}

function inertHandle(
  counters: PipelineCounters,
  attachment: StoreAttachment = NO_STORE,
): TelemetryHandle {
  let shutdownPromise: Promise<void> | undefined;
  return {
    store: attachment.store,
    ownsProvider: false,
    registered: {
      tracerProvider: false,
      contextManager: false,
      propagator: false,
    },
    counters,
    detachStore: attachment.detach,
    forceFlush: () => Promise.resolve(),
    shutdown: () => {
      shutdownPromise ??= settle(attachment.detach);
      return shutdownPromise;
    },
  };
}

/** This app's hold on the dashboard store; `detach` is idempotent and never throws. */
interface StoreAttachment {
  readonly store: TraceStore | undefined;
  readonly detach: () => void;
}

const NO_STORE: StoreAttachment = { store: undefined, detach: () => {} };

/**
 * Attaches this app to `store` with its scrub step and `redact` hook, when the dashboard
 * is on (`dashboardStore` set) and there is a store to attach to. Never throws.
 */
function attachStore(
  config: TelemetryConfig,
  store: TraceStore | undefined,
  diagnostics: TelemetryDiagnostics,
): StoreAttachment {
  if (!config.dashboardStore || !store) return NO_STORE;
  try {
    // Limits of a later app: applied while the store is still empty, else logged and ignored.
    getOrCreateStore(config.dashboardStore, diagnostics);
    const detach = store.attach({
      scrub: config.scrub,
      redact: config.redact,
      keepLogs: config.dashboardLogs !== false,
    });
    return { store, detach };
  } catch (error) {
    diagnostics.countFailure("store.attach", error);
    return NO_STORE;
  }
}

/** Resolves after `ms` without keeping the process alive. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Resolves when `work` settles or `ms` passes, whichever is first; tells which. Never rejects. */
async function bounded(
  work: () => unknown,
  ms: number,
): Promise<"done" | "timeout"> {
  return Promise.race([
    settle(work).then(() => "done" as const),
    delay(ms).then(() => "timeout" as const),
  ]);
}

/**
 * Registers Nestrix's OpenTelemetry pipeline, or steps aside for a host's. Never throws:
 * a failure is counted and the returned handle is inert.
 */
export function setupTelemetry(
  config: TelemetryConfig,
  diagnostics: TelemetryDiagnostics,
): TelemetryHandle {
  try {
    return setup(config, diagnostics);
  } catch (error) {
    diagnostics.countFailure("otel.setup", error);
    return inertHandle(newCounters());
  }
}

function setup(
  config: TelemetryConfig,
  diagnostics: TelemetryDiagnostics,
): TelemetryHandle {
  if (owned) {
    owned.refs++;
    diagnostics.logOnce(
      "otel.second-instance",
      "Another Nestrix instance in this process already owns the OpenTelemetry tracer provider; this one reports through it, with that instance's export, sampleRate, resource and redact settings.",
    );
    if (config.dashboardStore && !owned.store) {
      diagnostics.logOnce(
        "store.second-instance",
        "Another Nestrix instance in this process built the OpenTelemetry provider with the dashboard off, so the dashboard store receives no spans in this process.",
      );
    }
    return ownedHandle(
      owned,
      false,
      attachStore(config, owned.store, diagnostics),
    );
  }

  if (lostTo !== undefined && trace.getTracerProvider() === lostTo) {
    return hostHandle(config, diagnostics);
  }

  // Built before registering, because SDK 3's TracerProvider takes processors only in
  // its constructor. Everything here belongs to this provider alone, so shutting it
  // down after a lost race touches nothing of the host's (architecture §4.5).
  const counters = newCounters();
  const pipeline = createPipeline(config, counters, diagnostics);
  let store: TraceStore | undefined;
  let storeProcessor: ReturnType<typeof createStoreProcessor> | undefined;
  try {
    if (config.dashboardStore) {
      store = getOrCreateStore(config.dashboardStore, diagnostics);
      storeProcessor = createStoreProcessor(store);
    }
  } catch (error) {
    diagnostics.countFailure("store.setup", error);
  }
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
    spanProcessors: spanProcessors(pipeline, storeProcessor),
  });

  // When a host provider exists this writes one "Attempted duplicate registration of
  // API: trace" error, with a stack, to the host's diag logger (if it set one). There
  // is no silent public probe for a provider; see architecture §4.5.
  if (!trace.setGlobalTracerProvider(provider)) {
    void settle(() => provider.shutdown());
    try {
      lostTo = trace.getTracerProvider();
    } catch {
      lostTo = undefined;
    }
    return hostHandle(config, diagnostics);
  }

  if (!pipeline) {
    diagnostics.logOnce(
      "otel.export-off",
      "OTLP export is off: no endpoint is set (export.otlp.endpoint, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT), or export.otlp is false. Spans are created but not sent anywhere.",
    );
  }

  let contextManagerRegistered = false;
  try {
    if (hasContextManager()) {
      warnIfContextIsSyncOnly(diagnostics);
    } else {
      const manager = new AsyncLocalStorageContextManager().enable();
      contextManagerRegistered = context.setGlobalContextManager(manager);
      if (!contextManagerRegistered) manager.disable();
    }
  } catch (error) {
    diagnostics.countFailure("otel.context-manager", error);
  }
  let propagatorRegistered = false;
  try {
    if (!hasPropagator()) {
      propagatorRegistered = propagation.setGlobalPropagator(
        new W3CTraceContextPropagator(),
      );
    }
  } catch (error) {
    diagnostics.countFailure("otel.propagator", error);
  }

  owned = {
    provider,
    pipeline,
    store,
    counters,
    contextManagerRegistered,
    propagatorRegistered,
    timeoutMillis:
      config.shutdownTimeoutMillis ?? DEFAULT_SHUTDOWN_TIMEOUT_MILLIS,
    diagnostics,
    refs: 1,
  };
  return ownedHandle(owned, true, attachStore(config, store, diagnostics));
}

function hostHandle(
  config: TelemetryConfig,
  diagnostics: TelemetryDiagnostics,
): TelemetryHandle {
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
  let store: TraceStore | undefined;
  try {
    if (config.dashboardStore) {
      store = getOrCreateStore(config.dashboardStore, diagnostics);
      if (store.stats().processors === 0) {
        diagnostics.logOnce(
          "store.host-processor-hint",
          "The dashboard shows only spans that reach its store. Your application registered its own OpenTelemetry provider, so add Nestrix's processor to it: spanProcessors: [..., nestrixSpanProcessor()] (imported from @nestrix-js/nestjs).",
        );
      }
    }
  } catch (error) {
    diagnostics.countFailure("store.setup", error);
  }
  return inertHandle(newCounters(), attachStore(config, store, diagnostics));
}

/**
 * A handle on the shared owned provider. `first` is the handle that registered the
 * globals; later ones registered nothing (their `registered` flags are false).
 */
function ownedHandle(
  state: Owned,
  first: boolean,
  attachment: StoreAttachment,
): TelemetryHandle {
  let shutdownPromise: Promise<void> | undefined;
  const forceFlush = (): Promise<void> =>
    settle(() =>
      state.provider.forceFlush({ timeoutMillis: state.timeoutMillis }),
    );
  return {
    ownsProvider: true,
    registered: {
      tracerProvider: first,
      contextManager: first && state.contextManagerRegistered,
      propagator: first && state.propagatorRegistered,
    },
    counters: state.counters,
    store: attachment.store,
    detachStore: attachment.detach,
    forceFlush: () => (shutdownPromise ? Promise.resolve() : forceFlush()),
    shutdown: () => {
      shutdownPromise ??= settle(async () => {
        try {
          state.refs--;
          if (state.refs > 0) {
            // Other apps still serve: flush what is buffered, keep everything registered.
            await bounded(forceFlush, state.timeoutMillis);
            return;
          }
          await teardown(state);
        } finally {
          // After the flush, so spans ending during it still reach the store.
          attachment.detach();
        }
      });
      return shutdownPromise;
    },
  };
}

/**
 * The last handle closed: flush and shut down the provider within the bound, then remove
 * the globals Nestrix registered so a later app in the process can own them again.
 */
async function teardown(state: Owned): Promise<void> {
  const { diagnostics } = state;
  if (owned === state) owned = undefined;
  try {
    // New spans become no-ops from here on; spans already queued are still exported.
    trace.disable();
  } catch (error) {
    diagnostics.countFailure("otel.shutdown", error);
  }
  const outcome = await bounded(
    () => state.provider.shutdown(),
    state.timeoutMillis,
  );
  if (outcome === "timeout") {
    // Without this the batch processor's export timer, the exporter's socket and its
    // retries keep the process alive after the app closed.
    try {
      state.pipeline?.abort();
    } catch (error) {
      diagnostics.countFailure("otel.shutdown", error);
    }
    diagnostics.logOnce(
      "otel.shutdown-timeout",
      `Flushing spans on shutdown took longer than ${state.timeoutMillis} ms; the rest were dropped.`,
    );
  }
  // Last, so the exporter's in-flight requests kept their suppressed context.
  try {
    if (state.contextManagerRegistered) context.disable();
  } catch (error) {
    diagnostics.countFailure("otel.shutdown", error);
  }
  try {
    if (state.propagatorRegistered) propagation.disable();
  } catch (error) {
    diagnostics.countFailure("otel.shutdown", error);
  }
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
