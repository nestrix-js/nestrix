/**
 * Public options of `NestrixModule.forRoot()` / `forRootAsync()`.
 *
 * Phase 1 settles these names (docs/backlog/phase-1.md, "Public API"). They may still
 * change before 1.0. Resolution of defaults and environment variables lives in
 * `resolve-options.ts` (P1-02); nothing here has behaviour.
 */

/** A span as the `redact` hook sees it. Mutations are applied to the exported span. */
export interface RedactableSpan {
  readonly name: string;
  /** `SpanKind` as a number, as in `@opentelemetry/api`. */
  readonly kind: number;
  /** Mutable. Delete a key to remove it; assign to rewrite it. */
  attributes: Record<string, unknown>;
  /** Mutable, per event (an exception event's `exception.message` lives here). */
  readonly events: ReadonlyArray<{
    readonly name: string;
    attributes: Record<string, unknown>;
  }>;
}

/**
 * Called for every span the Nestrix-owned pipeline exports, after Nestrix's own redaction.
 * Return `false` to drop the span. A hook that throws drops the span (fail closed) and the
 * failure is counted. Not called for spans exported by a host-owned SDK (architecture §4.8).
 */
export type RedactHook = (span: RedactableSpan) => undefined | boolean;

/** Matches a request path (without query string) or an outgoing URL. */
export type UrlMatcher = string | RegExp | ((value: string) => boolean);

export interface NestrixOtlpOptions {
  /**
   * Base endpoint, e.g. `http://localhost:4318`; `/v1/traces` is appended.
   * Default: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (used as is), then
   * `OTEL_EXPORTER_OTLP_ENDPOINT`. With neither, nothing is exported.
   */
  endpoint?: string;
  /** Default: `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_TRACES_HEADERS`. */
  headers?: Record<string, string>;
  /** Per export request. Default 10000. */
  timeoutMillis?: number;
}

export interface NestrixQueueOptions {
  /** Spans buffered before new ones are dropped (and counted). Default 2048. */
  maxQueueSize?: number;
  /** Default 512. */
  maxExportBatchSize?: number;
  /** Default 5000. */
  scheduledDelayMillis?: number;
}

export interface NestrixExportOptions {
  /** `false` disables OTLP export even when the environment sets an endpoint. */
  otlp?: NestrixOtlpOptions | false;
  queue?: NestrixQueueOptions;
}

export interface NestrixIgnoreOptions {
  /** Incoming requests that get no server span (matched against the path, no query string). */
  routes?: UrlMatcher[];
  /**
   * Outgoing requests that get no client span and no `traceparent` (matched against the full URL).
   * For requests another tool makes inside a request, e.g. an error reporter's transport (§4.2).
   */
  outgoing?: UrlMatcher[];
}

export interface NestrixHttpOptions {
  /** Extra request headers recorded as `http.request.header.<name>`. Added to the default allowlist. */
  requestHeaders?: string[];
  /** Extra response headers recorded as `http.response.header.<name>`. Added to the default allowlist. */
  responseHeaders?: string[];
  /** Extra query-string keys whose values are replaced by `REDACTED`. Added to the default list. */
  redactQueryKeys?: string[];
}

export interface NestrixModuleOptions {
  /** Default `true`. `false`, or `NESTRIX_ENABLED=false` in the environment, registers nothing at all. */
  enabled?: boolean;
  /** `service.name`. Default `OTEL_SERVICE_NAME`, then the SDK's default resource. */
  serviceName?: string;
  /** Extra resource attributes. `OTEL_RESOURCE_ATTRIBUTES` is honoured too; these win. */
  resourceAttributes?: Record<string, string | number | boolean>;
  /**
   * Head sampling ratio for new root traces, 0 to 1. Default 1. Implemented as
   * `ParentBased(TraceIdRatioBased(sampleRate))`, so an incoming sampled `traceparent` is honoured.
   * Ignored when the host owns the SDK.
   */
  sampleRate?: number;
  export?: NestrixExportOptions;
  ignore?: NestrixIgnoreOptions;
  http?: NestrixHttpOptions;
  redact?: RedactHook;
}
