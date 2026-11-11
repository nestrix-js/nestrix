/**
 * OTLP/HTTP metric export (P6-02, D-64, D-66). Setup code, like otel/setup.ts: the only file under
 * `src/metrics/` that touches SDK packages, and only through a dynamic `import()` of the optional
 * peers `@opentelemetry/sdk-metrics` and `@opentelemetry/exporter-metrics-otlp-http`, started from
 * sync code (no top-level `await`, AGENTS.md rule 4).
 *
 * Runs only when Nestrix owns the tracer provider and a metrics URL resolved (core.ts decides).
 * Provider ownership follows architecture §4.5: Nestrix registers its `MeterProvider` only when
 * the silent probe finds none, and never replaces one. A missing package logs one line with the
 * install command; metrics then stay API-only (a host provider registered later still gets them).
 *
 * One owned provider per process, shared by every app that starts while it is open; the last one
 * to shut down flushes it (bounded) and unregisters it. Nothing here throws or rejects.
 */
import { metrics } from "@opentelemetry/api";
import type { Diagnostics } from "../diagnostics.js";
import { createExportAgents, type ExportAgents } from "../otel/export-agent.js";
import { settle } from "../otel/redacting-exporter.js";
import { buildResource } from "../otel/resource.js";
import type { ResolvedMetricExport } from "../resolve-options.js";
import { hasGlobalMeterProvider } from "./binding.js";

/** The parts of the SDK Nestrix uses, structurally, so no SDK type reaches the emitted `.d.ts`. */
export interface MetricsSdk {
  MeterProvider: new (options: {
    resource?: unknown;
    readers?: unknown[];
  }) => OwnedMeterProvider;
  PeriodicExportingMetricReader: new (options: {
    exporter: unknown;
    exportIntervalMillis?: number;
    exportTimeoutMillis?: number;
  }) => unknown;
  OTLPMetricExporter: new (options: {
    url?: string;
    headers?: Record<string, string>;
    timeoutMillis?: number;
    httpAgentOptions?: unknown;
  }) => unknown;
}

interface OwnedMeterProvider {
  getMeter: import("@opentelemetry/api").MeterProvider["getMeter"];
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

async function loadSdk(): Promise<MetricsSdk> {
  const [sdk, exporter] = await Promise.all([
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
  ]);
  return {
    MeterProvider: sdk.MeterProvider as unknown as MetricsSdk["MeterProvider"],
    PeriodicExportingMetricReader:
      sdk.PeriodicExportingMetricReader as unknown as MetricsSdk["PeriodicExportingMetricReader"],
    OTLPMetricExporter:
      exporter.OTLPMetricExporter as unknown as MetricsSdk["OTLPMetricExporter"],
  };
}

/** Internal test seam: replaces the dynamic import. Not exported from `src/index.ts`. */
export const metricsSdkLoader: { load: () => Promise<MetricsSdk> } = {
  load: loadSdk,
};

export const METRICS_INSTALL_MESSAGE =
  "OTLP metric export is off: it needs @opentelemetry/sdk-metrics and @opentelemetry/exporter-metrics-otlp-http, which are not installed. Install them with `pnpm add @opentelemetry/sdk-metrics@^3.1.1 @opentelemetry/exporter-metrics-otlp-http@^0.301.1`. Metrics are still recorded through @opentelemetry/api, so a MeterProvider your app registers receives them.";

const DEFAULT_SHUTDOWN_TIMEOUT_MILLIS = 5_000;
/** The periodic reader's own default export timeout; never longer than the interval. */
const MAX_EXPORT_TIMEOUT_MILLIS = 30_000;

export interface MetricExportConfig {
  readonly export: ResolvedMetricExport;
  readonly serviceName: string | undefined;
  readonly serviceVersion?: string | undefined;
  readonly resourceAttributes: Readonly<
    Record<string, string | number | boolean>
  >;
  readonly otelResourceAttributes?: string | undefined;
  readonly shutdownTimeoutMillis?: number | undefined;
}

export interface MetricExportHandle {
  /** Resolves once the SDK is loaded and the provider registered, or that failed. Never rejects. */
  readonly ready: Promise<void>;
  /** Exports what is aggregated. Never rejects. */
  forceFlush(): Promise<void>;
  /** Idempotent, bounded, never rejects. */
  shutdown(): Promise<void>;
}

interface Shared {
  refs: number;
  ready: Promise<void>;
  provider: OwnedMeterProvider | undefined;
  agents: ExportAgents | undefined;
  closed: boolean;
  timeoutMillis: number;
  diagnostics: Diagnostics;
  onRegistered: Set<() => void>;
}

let shared: Shared | undefined;
/** The last owned export's teardown while it runs: `metrics.disable()` has not run until it settles. */
let pendingTeardown: Promise<void> | undefined;

function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function bounded(
  work: () => unknown,
  ms: number,
): Promise<"done" | "timeout"> {
  return Promise.race([
    settle(work).then(() => "done" as const),
    delay(ms).then(() => "timeout" as const),
  ]);
}

async function load(state: Shared, config: MetricExportConfig): Promise<void> {
  const { diagnostics } = state;
  // A previous app's teardown may still be flushing; its `metrics.disable()` must run before the
  // probe below, or this app would see the old provider and never export.
  await settle(async () => pendingTeardown);
  let sdk: MetricsSdk;
  try {
    sdk = await metricsSdkLoader.load();
  } catch (error) {
    if (isModuleNotFound(error)) {
      diagnostics.logOnce("metrics.packages-missing", METRICS_INSTALL_MESSAGE);
    } else {
      diagnostics.countFailure("metrics.export.load", error);
    }
    return;
  }
  if (state.closed) return;
  if (hasGlobalMeterProvider()) {
    diagnostics.logOnce(
      "metrics.host-provider",
      "A MeterProvider is already registered, so Nestrix's metrics go to it and Nestrix does not export metrics itself.",
    );
    return;
  }
  const agents = createExportAgents();
  let provider: OwnedMeterProvider;
  try {
    const cfg = config.export;
    const exporter = new sdk.OTLPMetricExporter({
      url: cfg.url,
      headers: { ...cfg.headers },
      timeoutMillis: cfg.timeoutMillis,
      httpAgentOptions: (protocol: string) => agents.factory(protocol),
    });
    const reader = new sdk.PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: cfg.intervalMillis,
      exportTimeoutMillis: Math.min(
        cfg.intervalMillis,
        MAX_EXPORT_TIMEOUT_MILLIS,
      ),
    });
    provider = new sdk.MeterProvider({
      resource: buildResource(config),
      readers: [reader],
    });
  } catch (error) {
    agents.abort();
    diagnostics.countFailure("metrics.export.setup", error);
    return;
  }
  // The probe above already found no provider; this can only lose a race with code that ran in
  // between, and then writes the API's "duplicate registration" line to the diag logger.
  if (!metrics.setGlobalMeterProvider(provider)) {
    void settle(() => provider.shutdown());
    agents.abort();
    return;
  }
  state.provider = provider;
  state.agents = agents;
  for (const notify of state.onRegistered) {
    try {
      notify();
    } catch (error) {
      diagnostics.countFailure("metrics.export.notify", error);
    }
  }
}

async function teardown(state: Shared): Promise<void> {
  const { diagnostics } = state;
  state.closed = true;
  // The load is local disk; bounded anyway, so a hung import cannot hold the shutdown.
  const loaded = await bounded(() => state.ready, state.timeoutMillis);
  const provider = state.provider;
  if (loaded === "timeout" || provider === undefined) return;
  const outcome = await bounded(() => provider.shutdown(), state.timeoutMillis);
  if (outcome === "timeout") {
    try {
      state.agents?.abort();
    } catch (error) {
      diagnostics.countFailure("metrics.shutdown", error);
    }
    diagnostics.logOnce(
      "metrics.shutdown-timeout",
      `Flushing metrics on shutdown took longer than ${state.timeoutMillis} ms; the last export was dropped.`,
    );
  }
  disableOwn(state, provider);
}

function disableOwn(state: Shared, provider: OwnedMeterProvider): void {
  try {
    // Only Nestrix's own registration is removed, never a provider registered since.
    if (metrics.getMeterProvider() === provider) metrics.disable();
  } catch (error) {
    state.diagnostics.countFailure("metrics.shutdown", error);
  }
}

/**
 * Starts (or joins) the owned metric export. `onRegistered` runs once the owned provider is the
 * global one, so the caller can rebind its instruments. Never throws.
 */
export function startMetricExport(
  config: MetricExportConfig,
  diagnostics: Diagnostics,
  onRegistered: () => void,
): MetricExportHandle {
  let state: Shared;
  if (shared && !shared.closed) {
    state = shared;
    state.refs++;
    state.onRegistered.add(onRegistered);
    if (state.provider !== undefined) {
      try {
        onRegistered();
      } catch (error) {
        diagnostics.countFailure("metrics.export.notify", error);
      }
    }
  } else {
    state = {
      refs: 1,
      ready: Promise.resolve(),
      provider: undefined,
      agents: undefined,
      closed: false,
      timeoutMillis:
        config.shutdownTimeoutMillis ?? DEFAULT_SHUTDOWN_TIMEOUT_MILLIS,
      diagnostics,
      onRegistered: new Set([onRegistered]),
    };
    state.ready = settle(() => load(state, config));
    shared = state;
  }
  let shutdownPromise: Promise<void> | undefined;
  return {
    ready: state.ready,
    forceFlush: () =>
      settle(async () => {
        await state.ready;
        await state.provider?.forceFlush();
      }),
    shutdown: () => {
      shutdownPromise ??= settle(async () => {
        state.onRegistered.delete(onRegistered);
        state.refs--;
        if (state.refs > 0) return;
        // `pendingTeardown` stays set until `metrics.disable()` has run, so a load that starts in
        // the meantime waits for it before probing for a registered provider.
        const running = teardown(state).finally(() => {
          if (shared === state) shared = undefined;
          if (pendingTeardown === running) pendingTeardown = undefined;
        });
        pendingTeardown = running;
        await running;
      });
      return shutdownPromise;
    },
  };
}
