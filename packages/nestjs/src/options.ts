/**
 * Public options of `NestrixModule.forRoot()` / `forRootAsync()`.
 *
 * Phase 1 settles these names (docs/backlog/phase-1.md, "Public API"). They may still
 * change before 1.0. Resolution of defaults and environment variables lives in
 * `resolve-options.ts` (P1-02); nothing here has behaviour.
 */

import type { NestrixExportFailureCallback } from "./export-status.js";

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
export type RedactHook = (span: RedactableSpan) => boolean | void;

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
  /**
   * `false` turns off all OTLP export (traces, logs and metrics) even when the environment sets an
   * endpoint. The same `endpoint` and `headers` feed `/v1/traces`, `/v1/logs` and `/v1/metrics`.
   */
  otlp?: NestrixOtlpOptions | false;
  queue?: NestrixQueueOptions;
  /**
   * Lets the Nestrix standalone server order a CPU capture from this instance (D-76). Default
   * `false`. When `true`, the instance checks in every 15 s with `POST <endpoint>/v1/nestrix/check-in`
   * (same `headers`, so the same ingest key), and when an admin starts a capture in the server's
   * Profiler, runs it with the on-demand profiler (same limits, one capture per process) and
   * uploads the `.cpuprofile` itself. The server never connects to the instance. Needs a base
   * endpoint: `export.otlp.endpoint` or `OTEL_EXPORTER_OTLP_ENDPOINT` (a traces URL alone is not
   * enough), and `export.otlp` not `false`. Works without the embedded dashboard and with a
   * host-owned SDK. An endpoint that is not a Nestrix server (a Collector, Jaeger) answers 404,
   * and polling stops with one log line. Starting a capture pauses the main thread briefly.
   */
  profiler?: boolean;
  /**
   * Called once per failed export of Nestrix's own OTLP pipeline (traces, logs and metrics), after
   * the exporter's own retries: exactly when `getExportStatus()`'s `failures` total for that signal
   * goes up (D-110). Receives a frozen `{ signal, reason, httpStatus, error? }`. Synchronous; runs
   * on the exporter's timer, never in a request. A throw, or a promise's rejection, is counted and
   * logged once and never changes the export. Not called when the host's OpenTelemetry SDK owns
   * the signal: Nestrix does not see those exports. Not a function throws, like other options.
   */
  onFailure?: NestrixExportFailureCallback;
}

export interface NestrixIgnoreOptions {
  /**
   * Incoming requests that get no server span. Matched against the request path without the
   * query string; a string must equal the path exactly (`'/health'` does not match `'/health/live'`).
   */
  paths?: UrlMatcher[];
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
  /**
   * What the server span records as `url.path` (D-97), written when the response closes (never at
   * span start, so a sampler or `onStart` sees none). `'raw'` (default): the path as sent, with the
   * values of `redactPathParams` written as `REDACTED` when a route matched; with no route, the raw
   * path for a status below 400 (static files, raw adapter routes) or a 404, and nothing for any
   * other status from 400 (a body parser's 400, a middleware's 401, a 413) or no response. Not
   * covered: a pre-router middleware answering 2xx/3xx itself (a redirect) on a token-bearing
   * path keeps the raw path; `'template'` covers it. `'template'`: the matched route
   * template (`/invitations/:token`, the same value as `http.route`), or nothing when no route
   * matched. `ignore.paths` always matches the raw path.
   */
  recordPath?: "raw" | "template";
  /**
   * Extra route parameter names (`token` for `/invitations/:token`) whose values are written as
   * `REDACTED` in the server span's `url.path`, compared case-insensitively. Added to the default
   * list (`token`, `password`, `secret`, `jwt`, `session`, ...; README "Privacy"). Applied when the
   * response closes, using the route Nest matched; see `recordPath` for requests with no route.
   */
  redactPathParams?: string[];
  /**
   * Path patterns for outgoing requests whose matching segments are written as `REDACTED` in the
   * client span's `url.full` (D-97). A string is a path, optionally after an origin:
   * `'/v1/invitations/:token'` or `'https://api.example.com/v1/invitations/:token'`; `:name`
   * segments are redacted, `*` matches any one segment, other segments must be equal, and the
   * pattern matches the start of the path in whole segments. A `RegExp` runs on the path; each
   * capture group's text (or the whole match, with no group) becomes `REDACTED`, every match with
   * `g`. `ignore.outgoing` still sees the path as sent. Default: none.
   */
  redactOutgoingPath?: (string | RegExp)[];
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
  authorize(request: unknown): boolean | Promise<boolean>;
}

/** The embedded dashboard (phase 2). Requires `@nestrix-js/ui` to be installed. */
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
  /**
   * The on-demand CPU profiler in the dashboard (phase 7). Default `true`, but it is offered only
   * where the dashboard is authenticated: `enabled: true` (which requires `auth`), or `'auto'` with
   * the startup token or `auth`. `false` removes it: its routes are not registered.
   */
  profiler?: boolean;
  /**
   * Keep `NestrixLogger` lines next to their trace in the dashboard store (P9-07). Default `true`.
   * `false` keeps none: the logger still prints and the correlation ids are unchanged.
   */
  logs?: boolean;
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
export interface NestrixMethodsOptions {
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
export interface NestrixIntegrationsOptions {
  /**
   * `pg` query spans. Default `true`: on when `pg` is installed (D-50). Also measures how long
   * `pool.connect()` (and so `pool.query()`) waited for a client (D-98): the
   * `db.client.connection.wait_time` histogram and the `db.client.connection.count` and
   * `db.client.connection.pending_requests` metrics, per pool, unless `metrics` is `false`; and a
   * `pg.pool.connect` span when an acquisition inside a trace found no free client and waited at
   * least `poolWaitThresholdMillis` (default 5; `false` adds no such span, `0` one for every
   * acquisition that had to wait).
   */
  pg?: boolean | { poolWaitThresholdMillis?: number | false };
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
   * (`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is honoured, but does not turn export on by itself). Like
   * metrics, it runs only when Nestrix owns the trace provider (no host-owned SDK) and trace export
   * is on (D-69); with a host SDK, one log line says Nestrix registers no `LoggerProvider`. Needs the optional packages
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
  /**
   * Export over OTLP/HTTP from Nestrix's own `MeterProvider`. Default `true` (when its other
   * conditions hold). `false` keeps recording through the API only, so a `MeterProvider` your app
   * registers still receives the metrics.
   */
  export?: boolean;
}

/**
 * Which recorded exceptions count as errors (issue #25, D-94). An expected exception is still
 * recorded on its span and shown in the trace view, marked `nestrix.exception.expected = true`,
 * but is left out of the error list, the error groups and the trace's "has errors" marker. Route
 * error rates and SLOs do not change: they follow the response status.
 */
export interface NestrixErrorsOptions {
  /**
   * Default: an exception is expected when the status it maps to is below 500 (an `HttpException`
   * such as `NotFoundException` or `BadRequestException`); anything else maps to 500.
   * - An array of classes (matched with `instanceof`, so subclasses too), exact class names, or
   *   `RegExp`s tested against the class name: those are expected as well as the default ones.
   * - A function: called with each exception Nestrix records; `true` expected, `false` not
   *   expected, `undefined` the default rule. Must be synchronous; a throw counts as `undefined`.
   * - `false`: nothing is expected; a thrown 4xx is an error occurrence again.
   */
  expected?:
    | false
    | ClassMatcher[]
    | ((exception: unknown) => boolean | undefined);
}

/**
 * The local tail decision (D-100), active when `sampleRate` is below 1 and Nestrix owns the tracer
 * provider. A new trace the ratio leaves out is recorded in full and held in memory until its local
 * root span ends (at most 10,000 spans and 10,000 undecided traces in the process, the oldest
 * undecided trace dropped first and counted in `getExportStatus().traces.dropped`), then exported
 * when a rule below keeps it, else dropped. A trace whose incoming `traceparent` says not sampled
 * is not recorded: the calling service decided.
 */
export interface NestrixSamplingOptions {
  /**
   * Keep every trace in which a span failed: status error, unless every exception on it is
   * expected (`errors.expected`; a 4xx `HttpException` is expected by default). Default `true`.
   */
  keepErrors?: boolean;
  /**
   * Keep every trace whose local root span (the request, the job) took longer than this many
   * milliseconds. Default `false` (off): a useful threshold depends on the app, and any default
   * would export more than `sampleRate` says without being asked.
   */
  keepSlowerThanMs?: number | false;
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
   * default: a user id is personal data. Called once per recorded request (below `sampleRate` 1, every request while
   * the tail decision runs, D-100), when the response has
   * closed and before the server span ends, with the same request object guards get from
   * `context.switchToHttp().getRequest()`: Express's `req`, Fastify's `FastifyRequest` (not
   * `request.raw`), platform-node's `IncomingMessage`. So `request.user` set by a guard (Passport's
   * `AuthGuard`, your own) is visible; it is `undefined` when no guard set it (the route has none,
   * or a guard rejected first). Must be synchronous. Return a string or number, or `undefined` for
   * none; the value is cut to 256 characters. A throw, a promise or any other result records
   * nothing and is counted; the request is never affected. The attribute goes through `redact`.
   */
  user?(request: unknown): string | number | undefined;
  /**
   * Reads attributes of a request, such as its tenant or API client, set on the server span
   * (issue #27, D-102): `{ 'tenant.id': request.user?.tenantId, 'app.client_id': ... }`. Off by
   * default: a tenant id can be personal data. Called with the same request object as `user`, at
   * most once per sampled request: when the response has closed, or earlier when the handler
   * queues a job and `contextPropagation.keys` lists a key (guards have run by then). Must be
   * synchronous and return a plain object. Values: strings (cut to 256 characters), finite numbers,
   * booleans; `undefined` skips the key. At most 32 keys; names start with a letter and use
   * letters, digits, `_`, `.` and `-`; the `nestrix.`, `http.`, `url.`, `exception.` and other
   * semantic-convention prefixes and `user.id` are refused. A throw, a promise or an invalid entry
   * records nothing for it and is counted; the request is never affected. Values go through
   * `redact`. For work without a request, call `setTraceAttributes()`.
   */
  context?(
    request: unknown,
  ): Record<string, string | number | boolean | undefined> | undefined;
  /**
   * Carries some `context` and `setTraceAttributes()` keys to the jobs a request queues, as W3C
   * baggage in BullMQ's job metadata (`bullmqTelemetry()`), so the job's consumer span in the worker
   * carries them too (D-102). Default: nothing is propagated. The worker process must list the same
   * keys: only listed keys are read back from a job. With `outgoing: true` they are also sent in the
   * `baggage` header of outgoing HTTP requests (`node:http`, `fetch`) to every downstream service,
   * so leave it off unless those services are your own. At most 16 keys.
   */
  contextPropagation?: {
    keys: string[];
    outgoing?: boolean;
  };
  /** Method spans (level 2). `false` turns them off. */
  methods?: false | NestrixMethodsOptions;
  /** Database and cache spans (level 3). */
  integrations?: NestrixIntegrationsOptions;
  /** Extra resource attributes. `OTEL_RESOURCE_ATTRIBUTES` is honoured too; these win. */
  resourceAttributes?: Record<string, string | number | boolean>;
  /**
   * Head sampling ratio for new root traces, 0 to 1. Default `NESTRIX_SAMPLE_RATE` when set (read
   * only when this option is not given; a value that is not a number from 0 to 1 is a startup
   * error), else 1. Implemented as `ParentBased(TraceIdRatioBased(sampleRate))`, so an incoming
   * `traceparent` decides for its trace, sampled or not. Below 1, a new trace the ratio leaves out
   * is still recorded until its root span ends, and exported when it failed or was slow (see
   * `sampling`, D-100); calls to other services still carry the ratio's decision. Every exported
   * local root carries `nestrix.sampling.probability`, the chance it had of being kept (the
   * standalone server weights its counts by it). Ignored when the host owns the SDK.
   */
  sampleRate?: number;
  /** What sampling keeps besides `sampleRate`'s share (D-100). Ignored when the host owns the SDK. */
  sampling?: NestrixSamplingOptions;
  /**
   * Most spans one trace records in this process (D-78). Default 10,000; at least 100; `false`
   * turns the limit off. Spans past the limit are not recorded, and neither are their children;
   * they are counted by kind and the counts are written on the trace's local root span as
   * `nestrix.trace.spans_dropped` and `nestrix.trace.spans_dropped.<kind>`. Route and class
   * statistics still count every call. When the host owns the SDK, only Nestrix's own spans are
   * limited (the host's sampler decides the rest).
   */
  maxSpansPerTrace?: number | false;
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
  /** Which recorded exceptions are errors and which are expected answers (D-94). */
  errors?: NestrixErrorsOptions;
  /**
   * `http.server.request.duration` for every request, sampled or not, and runtime metrics. Default
   * on. `false` records no metrics at all.
   */
  metrics?: false | NestrixMetricsOptions;
}
