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
  /**
   * Mutable. `code` is `SpanStatusCode` as a number (0 unset, 1 ok, 2 error); `message`
   * is free text that often repeats an exception message: rewrite it, or delete it.
   * Links and their attributes are not exposed; to keep them out, drop the span.
   */
  status: { code: number; message?: string };
}

/**
 * Called for every span the Nestrix-owned pipeline exports, after Nestrix's own redaction.
 * Return `false` to drop the span. A hook that throws drops the span (fail closed) and the
 * failure is counted. Must be synchronous: a hook that returns a promise drops the span and
 * is counted as a failure. Not called for spans exported by a host-owned SDK (architecture §4.8).
 */
export type RedactHook = (span: RedactableSpan) => undefined | boolean;

/**
 * Matches a request path (without query string) or an outgoing URL. A `RegExp` is tested and a
 * function is called with that value; what a plain string means depends on the list (below).
 * A matcher that throws counts as a match, and the failure is counted.
 */
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
  /**
   * Incoming requests that get no server span. Matched against the request path without the
   * query string; a string must equal the path exactly (`'/health'` does not match `'/health/live'`).
   */
  routes?: UrlMatcher[];
  /**
   * Outgoing requests that get no client span and no `traceparent`. Matched against the recorded
   * `url.full` (userinfo removed, listed query values already `REDACTED`); a string is a prefix,
   * e.g. `'https://o123.ingest.sentry.io/'`.
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

/** Built-in token authentication for the dashboard (architecture §4.7). Compared in constant time. */
export interface NestrixUiTokenAuth {
  /** At least 32 characters. Sent as `Authorization: Bearer <token>`, or exchanged once for a cookie at `<path>/auth?token=`. */
  token: string;
}

/** Custom dashboard authentication (architecture §4.7). */
export interface NestrixUiCustomAuth {
  /**
   * Called for every dashboard request with the raw, adapter-specific request, before any Nest
   * guard has run (so `request.user` is not populated). Return `true` to allow. A throw, a
   * rejection or any other value denies.
   */
  authorize: (request: unknown) => boolean | Promise<boolean>;
}

/** The embedded dashboard (phase 2). Requires `@nestrix/ui` to be installed. */
export interface NestrixUiOptions {
  /**
   * `'auto'` (default): served only when `NODE_ENV` is `development` or unset, to loopback
   * requests with no forwarding headers that carry the startup token cookie.
   * `true`: served to any request that passes `auth`, in any environment; `auth` is required, and
   * without it the dashboard stays off and an error is logged (the app still starts).
   * `false`: off.
   */
  enabled?: boolean | "auto";
  /** Default `'/_nestrix'`. Sits outside the global prefix and versioning. */
  path?: string;
  /** Required when `enabled` is `true`. In `'auto'` mode it is checked in addition to the local-only rules. */
  auth?: NestrixUiTokenAuth | NestrixUiCustomAuth;
  /**
   * `'auto'` mode only. Default `true`: a random token is generated at startup and a link carrying it
   * is logged; opening the link stores it in an HttpOnly cookie, and requests without it get no
   * dashboard. `false` drops this check, and a same-host reverse proxy that adds no forwarding headers
   * then exposes the dashboard (architecture §4.7).
   */
  startupToken?: boolean;
}

/** The dashboard's in-memory store of recent traces. Oldest evicted first; nothing is written to disk. */
export interface NestrixStoreOptions {
  /** Traces kept. Default 5,000 (measured in P2-12; see `store/limits.ts`). */
  maxTraces?: number;
  /** Approximate bytes kept. Default 32 MiB (measured in P2-12; see `store/limits.ts`). */
  maxBytes?: number;
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
  /** The embedded dashboard. Default `'auto'` (architecture §4.7). `false` turns it off. */
  ui?: false | "auto" | NestrixUiOptions;
  /** Limits of the dashboard's store. Ignored while the dashboard is off. */
  store?: NestrixStoreOptions;
}
