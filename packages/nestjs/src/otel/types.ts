/**
 * The inputs and output of `setupTelemetry`. Structural on purpose: `ResolvedOptions`
 * (resolve-options.ts) satisfies `TelemetryConfig` as it is, and the optional fields
 * below are the ones the caller adds when wiring.
 */
import type { RedactableSpan, RedactHook } from "../options.js";

export interface TelemetryOtlpConfig {
  /** Full traces URL, `/v1/traces` already applied. Passed to the exporter as is. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Per export, including the exporter's own retries. */
  readonly timeoutMillis: number;
}

export interface TelemetryQueueConfig {
  readonly maxQueueSize: number;
  readonly maxExportBatchSize: number;
  readonly scheduledDelayMillis: number;
}

export interface TelemetryConfig {
  /** `service.name`. Already resolved from the option and `OTEL_SERVICE_NAME`. */
  readonly serviceName: string | undefined;
  /** Option-supplied resource attributes. They win over `otelResourceAttributes`. */
  readonly resourceAttributes: Readonly<
    Record<string, string | number | boolean>
  >;
  /**
   * The raw value of `OTEL_RESOURCE_ATTRIBUTES`. SDK 3's `TracerProvider` does not read
   * it (it uses `defaultResource()` only), so Nestrix parses it here. Malformed values
   * are discarded whole, as the specification requires.
   */
  readonly otelResourceAttributes?: string | undefined;
  /** Root sampling ratio in [0, 1]; validated by the caller. */
  readonly sampleRate: number;
  readonly export: {
    readonly otlp: TelemetryOtlpConfig | false;
    readonly queue: TelemetryQueueConfig;
  };
  /** The user's hook. Runs after `scrub`, for every span the owned pipeline exports. */
  readonly redact: RedactHook | undefined;
  /**
   * Nestrix's own, store-independent redaction step (privacy.ts), applied to every
   * exported span before `redact`. A throw drops the span and counts the failure.
   */
  readonly scrub?: ((span: RedactableSpan) => void) | undefined;
  /** Upper bound for `shutdown()`. Default 5000. */
  readonly shutdownTimeoutMillis?: number | undefined;
}

/** Same shape as `Diagnostics` in diagnostics.ts. Neither method may throw. */
export interface TelemetryDiagnostics {
  logOnce(key: string, message: string): void;
  countFailure(where: string, error: unknown): void;
}

/** Live counters. Numbers only grow. */
export interface TelemetryCounters {
  /** Spans the batch processor dropped because its queue was full. */
  readonly droppedSpans: number;
  /** Spans handed to the exporter whose export succeeded. */
  readonly exportedSpans: number;
  /**
   * Spans handed to the exporter whose export failed (after the exporter's own retries),
   * was cut off at the shutdown bound, or was not attempted because an earlier export
   * was still in flight past the batch processor's export timeout (redacting-exporter.ts).
   */
  readonly exportFailedSpans: number;
  /** Spans the `redact` hook dropped by returning `false`. */
  readonly redactDroppedSpans: number;
  /** Spans dropped because `scrub` or `redact` threw, or left the span unusable. */
  readonly redactFailedSpans: number;
}

export interface TelemetryHandle {
  /** `true` when Nestrix registered the global tracer provider and runs the export pipeline. */
  readonly ownsProvider: boolean;
  /** Which globals Nestrix registered. Each is `false` when something else held the slot. */
  readonly registered: {
    readonly tracerProvider: boolean;
    readonly contextManager: boolean;
    readonly propagator: boolean;
  };
  readonly counters: TelemetryCounters;
  /** Exports what is buffered. Never rejects. Does nothing for a host-owned provider. */
  forceFlush(): Promise<void>;
  /**
   * Flushes and shuts down the owned provider, bounded by `shutdownTimeoutMillis`, then
   * removes the globals Nestrix registered so a later app in the same process can own
   * them again. Idempotent. Never rejects. Never touches a host provider.
   */
  shutdown(): Promise<void>;
}
