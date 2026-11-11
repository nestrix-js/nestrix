/**
 * Metrics wiring (P6-02, D-66), called from `NestrixCore`'s constructor after the telemetry setup;
 * the owned export starts later, from `NestrixCore.onApplicationBootstrap()`.
 *
 * - Recording always goes through `@opentelemetry/api` (binding.ts), so a host `MeterProvider`
 *   receives the request histogram and runtime instruments with no extra package.
 * - Export (export.ts) starts only when Nestrix owns the tracer provider and `metrics.export`
 *   resolved (not `export: false`, trace export on and a metrics URL).
 *
 * Never throws: a failure is counted and metrics are off.
 */
import type { Diagnostics } from "../diagnostics.js";
import type { TelemetryHandle } from "../otel/types.js";
import type { ResolvedOptions } from "../resolve-options.js";
import { MeterBinding } from "./binding.js";
import { type MetricExportHandle, startMetricExport } from "./export.js";
import { HttpRequestMetrics } from "./http.js";

export interface NestrixMetrics {
  /** Passed to the HTTP request hook. */
  readonly http: HttpRequestMetrics;
  /** The owned export, once `startExport()` started it. */
  readonly export: MetricExportHandle | undefined;
  /**
   * Starts the owned export, when Nestrix owns the tracer provider and export resolved. Called at
   * `onApplicationBootstrap`, after every host `onModuleInit`, so a host that registers its own
   * `MeterProvider` there wins the silent probe. Idempotent, never throws.
   */
  startExport(): void;
  /** Flushes and stops the owned export (bounded), then stops the runtime instruments. Never rejects. */
  shutdown(): Promise<void>;
}

export function startMetrics(
  options: Pick<
    ResolvedOptions,
    | "metrics"
    | "serviceName"
    | "serviceVersion"
    | "resourceAttributes"
    | "otelResourceAttributes"
  >,
  telemetry: Pick<TelemetryHandle, "ownsProvider"> | undefined,
  diagnostics: Diagnostics,
): NestrixMetrics | undefined {
  try {
    const resolved = options.metrics;
    if (resolved === false) return undefined;
    const binding = new MeterBinding(resolved.runtime, diagnostics);
    let exportHandle: MetricExportHandle | undefined;
    let exportStarted = false;
    // Binds now to whatever provider is registered (a host's), so runtime instruments start
    // without waiting for a first request.
    binding.refresh();
    let shutdownPromise: Promise<void> | undefined;
    return {
      http: new HttpRequestMetrics(binding, diagnostics),
      get export() {
        return exportHandle;
      },
      startExport: () => {
        if (exportStarted) return;
        exportStarted = true;
        try {
          if (telemetry?.ownsProvider !== true || resolved.export === false) {
            return;
          }
          exportHandle = startMetricExport(
            {
              export: resolved.export,
              serviceName: options.serviceName,
              serviceVersion: options.serviceVersion,
              resourceAttributes: options.resourceAttributes,
              otelResourceAttributes: options.otelResourceAttributes,
            },
            diagnostics,
            () => binding.refresh(),
          );
        } catch (error) {
          diagnostics.countFailure("metrics.start", error);
        }
      },
      shutdown: () => {
        shutdownPromise ??= (async () => {
          try {
            // First, so the final collection still includes the runtime instruments.
            await exportHandle?.shutdown();
          } catch (error) {
            diagnostics.countFailure("metrics.shutdown", error);
          }
          binding.close();
        })();
        return shutdownPromise;
      },
    };
  } catch (error) {
    diagnostics.countFailure("metrics.start", error);
    return undefined;
  }
}
