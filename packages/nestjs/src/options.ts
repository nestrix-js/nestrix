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

/**
 * Names a class for `methods.include` / `methods.exclude`: the class itself, its exact name, or a
 * `RegExp` tested against its name.
 */
export type ClassMatcher =
  | string
  | RegExp
  | (abstract new (
      ...args: never[]
    ) => unknown);

/** Enhancer roles whose spans can be switched on (D-47, D-57). */
export type NestrixEnhancerKind = "guard" | "pipe" | "interceptor" | "filter";

/**
 * Method spans (level 2, phase 3). They need `NestFactory.create(AppModule, { instrument: NestrixInstrument })`
 * in `main.ts`; these options only shape what is traced. Not applied under `@nestjs/testing` (D-48).
 */
export interface NestrixMethodOptions {
  /** Default `true` (effective only with `NestrixInstrument`). `false` turns method spans off. */
  enabled?: boolean;
  /**
   * Classes traced in addition to the app's own controllers, services, repositories and processors
   * (D-57), for example a provider from your own dynamic module or a library service you care about.
   */
  include?: ClassMatcher[];
  /** Classes never traced. Wins over `include`. */
  exclude?: ClassMatcher[];
  /** Spans for guards, pipes, interceptors and filters. Default `false`; `true` is all four. */
  enhancers?: boolean | NestrixEnhancerKind[];
}

/** Database and cache integrations (level 3, phase 3). */
export interface NestrixIntegrationOptions {
  /** `pg` query spans. Default `true`: on when `pg` is installed (D-50). */
  pg?: boolean;
  /**
   * `mysql2` query spans. Default `false` (D-49): once on, mysql2 swallows an error from an
   * event-emitter query that has no `'error'` listener, where it would otherwise crash the process.
   */
  mysql2?: boolean;
  /**
   * `ioredis` command spans. Default `false` (D-49): once on, ioredis swallows the rejection of a
   * failing command nobody awaits, where it would otherwise raise `unhandledRejection`.
   * `rootSpans: true` also keeps commands that run outside any trace (connection handshakes,
   * commands queued before the connection was ready); by default they are dropped (D-60).
   */
  ioredis?: boolean | { rootSpans?: boolean };
}

export interface NestrixLogsOptions {
  /**
   * Also send every `NestrixLogger` record over OTLP/HTTP to `/v1/logs` of the configured endpoint
   * (`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is honoured). Needs the optional packages
   * `@opentelemetry/sdk-logs` and `@opentelemetry/exporter-logs-otlp-http`; without them one log line
   * says so. Default `false`.
   */
  export?: boolean;
}

/**
 * Metrics (D-66). Recorded through `@opentelemetry/api`'s metrics API, so a `MeterProvider` your
 * app registers receives them as is. Exported over OTLP/HTTP only when Nestrix owns the tracer
 * provider, an endpoint is set, and `@opentelemetry/sdk-metrics` and
 * `@opentelemetry/exporter-metrics-otlp-http` are installed.
 */
export interface NestrixMetricsOptions {
  /**
   * Event-loop delay, V8 heap, RSS and CPU time as observable instruments. Default `true`. They
   * start only once a real `MeterProvider` is registered (your app's or Nestrix's).
   */
  runtime?: boolean;
}

export interface NestrixModuleOptions {
  /** Default `true`. `false`, or `NESTRIX_ENABLED=false` in the environment, registers nothing at all. */
  enabled?: boolean;
  /** `service.name`. Default `OTEL_SERVICE_NAME`, then the SDK's default resource. */
  serviceName?: string;
  /**
   * `service.version`: the release every trace is tagged with (D-56, D-63). Default, first set value
   * wins: `resourceAttributes['service.version']`, then `service.version` in
   * `OTEL_RESOURCE_ATTRIBUTES`, then `GIT_SHA`, then `npm_package_version` (set by `npm`/`pnpm run`,
   * not by `node main.js`). Blank values are skipped. Ignored when the host owns the SDK (its
   * resource wins).
   */
  serviceVersion?: string;
  /**
   * Reads the user behind a request, recorded as `user.id` on the server span (D-56). Off by
   * default: a user id is personal data. Called once per sampled request, when the response has
   * closed and before the server span ends, with the same request object guards get from
   * `context.switchToHttp().getRequest()`: Express's `req`, Fastify's `FastifyRequest` (not
   * `request.raw`), platform-node's `IncomingMessage`. So `request.user` set by a guard (Passport's
   * `AuthGuard`, your own) is visible; it is `undefined` when no guard set it (the route has none,
   * or a guard rejected first). Must be synchronous. Return a string or number, or `undefined` for
   * none; the value is cut to 256 characters. A throw, a promise or any other result records
   * nothing and is counted; the request is never affected. The attribute goes through `redact`.
   */
  user?: (request: unknown) => string | number | undefined;
  /** Method spans (level 2). */
  methods?: NestrixMethodOptions;
  /** Database and cache spans (level 3). */
  integrations?: NestrixIntegrationOptions;
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
  /** Log correlation and export (`NestrixLogger`). */
  logs?: NestrixLogsOptions;
  /**
   * `http.server.request.duration` for every request, sampled or not, and runtime metrics. Default
   * on. `false` records no metrics at all.
   */
  metrics?: false | NestrixMetricsOptions;
}
