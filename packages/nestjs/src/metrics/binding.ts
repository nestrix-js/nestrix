/**
 * Which `MeterProvider` Nestrix's instruments live on (P6-02, D-66).
 *
 * `@opentelemetry/api` 1.10 has no proxy meter provider: `metrics.getMeter()` before a provider
 * is registered returns the no-op meter, and instruments made from it stay no-ops after one is
 * registered (`api/metrics.mjs`: `getGlobal("metrics") || NOOP_METER_PROVIDER`). So the binding
 * compares `metrics.getMeterProvider()` with the provider it built on, on every request and when
 * Nestrix's own provider registers, and rebuilds its instruments when it changed. The comparison
 * is one global lookup; nothing is allocated.
 *
 * While the global provider is the API's no-op one, there are no instruments at all: the request
 * path records nothing and builds no attributes, and the event-loop monitor does not run.
 *
 * Imports `@opentelemetry/api` only (AGENTS.md rule 5). Nothing here throws.
 */
import {
  createNoopMeter,
  type Histogram,
  type Meter,
  type MeterProvider,
  metrics,
  type ObservableCallback,
  type ObservableCounter,
} from "@opentelemetry/api";
import { METRIC_HTTP_SERVER_REQUEST_DURATION } from "@opentelemetry/semantic-conventions";
import type { Diagnostics } from "../diagnostics.js";
import { exportCounts, isExportActive } from "../export-status.js";
import { type RuntimeMetrics, startRuntimeMetrics } from "./runtime.js";

/** Meter name, the same as the tracer's (`TRACER_NAME` in http/server.ts). */
export const METER_NAME = "@nestrix-js/nestjs";

/** Bucket boundaries the HTTP semantic conventions advise for `http.server.request.duration`, in seconds. */
export const HTTP_DURATION_BUCKETS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
]);

let noopMeterPrototype: object | null | undefined;

/** Whether `meter` is the API's no-op meter (what an unset global provider hands out). */
export function isNoopMeter(meter: unknown): boolean {
  if (meter === null || typeof meter !== "object") return true;
  noopMeterPrototype ??= Object.getPrototypeOf(createNoopMeter()) as object;
  return Object.getPrototypeOf(meter) === noopMeterPrototype;
}

/**
 * Whether a real `MeterProvider` is registered globally. Silent: unlike
 * `metrics.setGlobalMeterProvider`, it writes nothing to the diag logger. A host that registers
 * the API's own `NoopMeterProvider` counts as none.
 */
export function hasGlobalMeterProvider(): boolean {
  try {
    return !isNoopMeter(metrics.getMeterProvider().getMeter(METER_NAME));
  } catch {
    // A provider whose getMeter throws: treat it as present, so Nestrix never replaces it.
    return true;
  }
}

/** D-82: failed OTLP exports of Nestrix's own pipeline, by `signal` and `reason`. */
export const METRIC_EXPORT_FAILURES = "nestrix.export.failures";
/** D-82: spans and log records Nestrix's own pipeline dropped from its bounded queue, by `signal`. */
export const METRIC_EXPORT_DROPPED = "nestrix.export.dropped";

/**
 * Reads the export status's cumulative counts (export-status.ts) at collection time. Nothing is
 * recorded on the export path, so a failing metric export cannot cause more exports: its own failure
 * shows up, once per interval, in the next export. Never throws.
 */
const observeFailures: ObservableCallback = (result) => {
  try {
    for (const { signal, failures, active } of exportCounts()) {
      if (!active) continue;
      for (const [reason, count] of Object.entries(failures)) {
        if (count > 0) result.observe(count, { signal, reason });
      }
    }
  } catch {
    // Never throws into the SDK's collection.
  }
};

const observeDropped: ObservableCallback = (result) => {
  try {
    for (const { signal, dropped, active } of exportCounts()) {
      if (active && signal !== "metrics") result.observe(dropped, { signal });
    }
  } catch {
    // Never throws into the SDK's collection.
  }
};

const UNBOUND = Symbol("unbound");

export class MeterBinding {
  private provider: MeterProvider | typeof UNBOUND = UNBOUND;
  private histogram: Histogram | undefined;
  private runtime: RuntimeMetrics | undefined;
  private exportInstruments:
    | { failures: ObservableCounter; dropped: ObservableCounter }
    | undefined;
  private closed = false;

  /**
   * `exportStatus`: also report `nestrix.export.failures` and `nestrix.export.dropped` (D-82). Set
   * only when Nestrix owns the tracer provider; they are created only while its trace export is
   * on, so a host-owned SDK sees no new instrument.
   */
  constructor(
    private readonly runtimeEnabled: boolean,
    private readonly diagnostics: Diagnostics,
    private readonly exportStatus = false,
  ) {}

  /**
   * The request-duration histogram on the current global provider, rebinding first when that
   * provider changed; `undefined` when there is no real provider or after `close()`. Never throws.
   */
  requestDuration(): Histogram | undefined {
    try {
      const provider = metrics.getMeterProvider();
      if (provider !== this.provider) this.bind(provider);
    } catch (error) {
      this.diagnostics.countFailure("metrics.bind", error);
    }
    return this.histogram;
  }

  /** Rebinds now if the global provider changed (Nestrix's own provider just registered). */
  refresh(): void {
    this.requestDuration();
  }

  /** Stops the runtime instruments and records nothing more. Idempotent; never throws. */
  close(): void {
    this.closed = true;
    this.unbind();
  }

  private unbind(): void {
    this.histogram = undefined;
    const exportInstruments = this.exportInstruments;
    this.exportInstruments = undefined;
    try {
      exportInstruments?.failures.removeCallback(observeFailures);
      exportInstruments?.dropped.removeCallback(observeDropped);
    } catch (error) {
      this.diagnostics.countFailure("metrics.export-status-stop", error);
    }
    const runtime = this.runtime;
    this.runtime = undefined;
    try {
      runtime?.stop();
    } catch (error) {
      this.diagnostics.countFailure("metrics.runtime-stop", error);
    }
  }

  private bind(provider: MeterProvider): void {
    // Remembered first: a provider that throws below is not retried on every request.
    this.provider = provider;
    this.unbind();
    if (this.closed) return;
    let meter: Meter;
    try {
      meter = provider.getMeter(METER_NAME);
    } catch (error) {
      this.diagnostics.countFailure("metrics.get-meter", error);
      return;
    }
    if (isNoopMeter(meter)) return;
    try {
      this.histogram = meter.createHistogram(
        METRIC_HTTP_SERVER_REQUEST_DURATION,
        {
          description: "Duration of HTTP server requests.",
          unit: "s",
          advice: { explicitBucketBoundaries: [...HTTP_DURATION_BUCKETS] },
        },
      );
    } catch (error) {
      this.diagnostics.countFailure("metrics.create-histogram", error);
    }
    if (this.runtimeEnabled) {
      this.runtime = startRuntimeMetrics(meter, this.diagnostics);
    }
    if (this.exportStatus && isExportActive("traces")) {
      try {
        const failures = meter.createObservableCounter(METRIC_EXPORT_FAILURES, {
          description:
            "Failed OTLP exports of Nestrix's own pipeline, by signal and reason.",
          unit: "{export}",
        });
        const dropped = meter.createObservableCounter(METRIC_EXPORT_DROPPED, {
          description:
            "Spans and log records Nestrix dropped before export because its bounded queue was full.",
          unit: "{item}",
        });
        failures.addCallback(observeFailures);
        dropped.addCallback(observeDropped);
        this.exportInstruments = { failures, dropped };
      } catch (error) {
        this.diagnostics.countFailure("metrics.export-status", error);
      }
    }
  }
}
