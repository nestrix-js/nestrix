/**
 * Metrics wiring (P6-02, D-66), called from `NestrixCore`'s constructor after the telemetry setup.
 *
 * - Recording always goes through `@opentelemetry/api` (binding.ts), so a host `MeterProvider`
 *   receives the request histogram and runtime instruments with no extra package.
 * - Export (export.ts) starts only when Nestrix owns the tracer provider and `metrics.export`
 *   resolved (trace export on and a metrics URL).
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
  /** The owned export, when it started. */
  readonly export: MetricExportHandle | undefined;
  /** Flushes and stops the owned export (bounded), then stops the runtime instruments. Never rejects. */
  shutdown(): Promise<void>;
}

export function startMetrics(
  options: Pick<
    ResolvedOptions,
    "metrics" | "serviceName" | "resourceAttributes" | "otelResourceAttributes"
  >,
  telemetry: Pick<TelemetryHandle, "ownsProvider"> | undefined,
  diagnostics: Diagnostics,
): NestrixMetrics | undefined {
  try {
    const resolved = options.metrics;
    if (resolved === false) return undefined;
    const binding = new MeterBinding(resolved.runtime, diagnostics);
    let exportHandle: MetricExportHandle | undefined;
    if (telemetry?.ownsProvider === true && resolved.export !== false) {
      exportHandle = startMetricExport(
        {
          export: resolved.export,
          serviceName: options.serviceName,
          resourceAttributes: options.resourceAttributes,
          otelResourceAttributes: options.otelResourceAttributes,
        },
        diagnostics,
        () => binding.refresh(),
      );
    }
    // Binds now to whatever provider is registered (a host's), so runtime instruments start
    // without waiting for a first request.
    binding.refresh();
    let shutdownPromise: Promise<void> | undefined;
    return {
      http: new HttpRequestMetrics(binding, diagnostics),
      export: exportHandle,
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
