# Configuration reference

Every option is optional. `NestrixModule.forRoot(options?)` and the object `forRootAsync`'s factory returns take the same shape. Invalid values (a `sampleRate` outside 0 to 1, a non-positive queue size) throw: with `forRoot` when `forRoot()` is called, with `forRootAsync` when the factory's result is resolved during `NestFactory.create`. The exception is `ui`, which never throws; an invalid value leaves the dashboard off and logs an error.

A table is checked against `packages/nestjs/src/options.ts` by `docs-site/scripts/check-options.mjs` on every docs build: an option added there and missing here fails the build.

## Top level

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | `false` registers nothing at all. `NESTRIX_ENABLED=false` (or `0`) in the environment does the same and wins over `enabled: true`: it is a kill switch. With `forRootAsync`, `enabled: false` from the factory leaves the providers registered but inert. |
| `serviceName` | `OTEL_SERVICE_NAME`, then the SDK's default | The `service.name` resource attribute. |
| `serviceVersion` | first set of: `resourceAttributes['service.version']`, `service.version` in `OTEL_RESOURCE_ATTRIBUTES`, `GIT_SHA`, `npm_package_version` | The release every trace is tagged with. Blank values are skipped. Ignored when your app owns the SDK. |
| `user` | none (off) | Reads the user behind a request, recorded as `user.id` on the server span. Called once per sampled request as the response closes, with the request object guards get. Must be synchronous; return a string or number (cut to 256 characters) or `undefined`. A throw, a promise or any other result records nothing and is counted. Goes through `redact`. |
| `resourceAttributes` | none | Extra resource attributes. `OTEL_RESOURCE_ATTRIBUTES` is honoured too; these win. Ignored when your app owns the SDK. |
| `sampleRate` | `1` | Head sampling ratio for new root traces, 0 to 1, as `ParentBased(TraceIdRatioBased(sampleRate))`, so an incoming sampled `traceparent` is honoured. Ignored when your app owns the SDK. |
| `methods` | an object | Method spans (level 2). See [`methods`](#methods). |
| `integrations` | an object | Database and cache spans (level 3). See [`integrations`](#integrations). |
| `export` | an object | OTLP export and its queue. See [`export`](#export). |
| `ignore` | none | Requests that get no span. See [`ignore`](#ignore). |
| `http` | none | Extra allowlisted headers and redacted query keys. See [`http`](#http). |
| `redact` | none | A synchronous hook that sees every exported span and every span the dashboard stores. See [`redact`](#redact). |
| `ui` | `'auto'` | The embedded dashboard: `false`, `'auto'` or an object. See [`ui`](#ui). |
| `store` | an object | Limits of the dashboard's in-memory store. See [`store`](#store). |
| `logs` | `{ export: false }` | Log export over OTLP. See [`logs`](#logs). |
| `metrics` | on | Request-duration and runtime metrics. `false` records no metrics at all. See [`metrics`](#metrics). |

## `methods`

Method spans need `instrument: NestrixInstrument` in `main.ts`; without it these options do nothing. They are not applied under `@nestjs/testing`.

| Option | Default | Description |
|---|---|---|
| `methods` | an object, or `false` | `false` turns method spans off. |
| `methods.include` | none | Classes traced in addition to your own controllers, services, repositories and processors: a class, an exact name or a `RegExp`. |
| `methods.exclude` | none | Classes never traced, in the same forms. Wins over `include`. |
| `methods.enhancers` | `false` | `true` for guard, pipe, interceptor and filter spans, or an array such as `['guard']` for some. |

## `integrations`

| Option | Default | Description |
|---|---|---|
| `integrations.pg` | `true` | `pg` query spans; on when `pg` is installed. |
| `integrations.mysql2` | `false` | `mysql2` query spans. Opt-in: once on, mysql2 swallows an error from an event-emitter query that has no `'error'` listener. |
| `integrations.ioredis` | `false` | `ioredis` command spans. Opt-in: once on, ioredis swallows the rejection of a failing command nobody awaits. `{ rootSpans: true }` also keeps commands that run outside any trace (dropped by default). |

## `export`

`export.otlp` is an object, or `false` to turn off all OTLP export (traces, logs and metrics) even when the environment sets an endpoint. The same `endpoint` and `headers` feed `/v1/traces`, `/v1/logs` and `/v1/metrics`.

| Option | Default | Description |
|---|---|---|
| `export.otlp.endpoint` | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (used as given), then `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL such as `http://localhost:4318`; `/v1/traces` is appended. With no endpoint anywhere, nothing is exported. |
| `export.otlp.headers` | `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | Headers sent with every export request, for example an API key. The option wins key by key; the traces variable wins over the generic one. |
| `export.otlp.timeoutMillis` | `10000` | Timeout per export request. Positive integer; validated only when an endpoint resolves. |
| `export.queue.maxQueueSize` | `2048` | Spans buffered before new ones are dropped (and counted). |
| `export.queue.maxExportBatchSize` | `512` | Spans per export request. Must not exceed `maxQueueSize`. |
| `export.queue.scheduledDelayMillis` | `5000` | How often a partial batch is exported. A full batch is exported at once. |
| `export.profiler` | `false` | Lets the [standalone server](/guide/standalone-server#remote-cpu-profiling) take CPU profiles of this instance: it checks in every 15 s and uploads a capture an admin ordered. Needs `export.otlp.endpoint` or `OTEL_EXPORTER_OTLP_ENDPOINT` (a full traces URL alone is not enough). With a base from `OTEL_EXPORTER_OTLP_ENDPOINT` only `OTEL_EXPORTER_OTLP_HEADERS` and `export.otlp.headers` are sent, never `OTEL_EXPORTER_OTLP_TRACES_HEADERS`. A non-boolean throws. |

All three queue values must be positive integers.

## `ignore`

| Option | Default | Description |
|---|---|---|
| `ignore.paths` | none | Incoming requests that get no server span. Matched against the request path without the query string. A string must equal the path exactly: `"/health"` does not match `"/health/live"`. |
| `ignore.outgoing` | none | Outgoing requests that get no client span and no `traceparent`. Matched against the recorded `url.full` (credentials removed, listed query values already `REDACTED`). A string is a **prefix**, for example `"https://o123.ingest.sentry.io/"`. |

A matcher is a string, a `RegExp` or a function that receives the path or URL and returns `true` to match. A matcher that throws counts as a match, and the failure is counted.

## `http`

These add to the [privacy defaults](/faq#privacy); they never replace them.

| Option | Default | Description |
|---|---|---|
| `http.requestHeaders` | none | Extra request headers recorded as `http.request.header.<name>`. |
| `http.responseHeaders` | none | Extra response headers recorded as `http.response.header.<name>`. |
| `http.redactQueryKeys` | none | Extra query-string keys whose values are replaced by `REDACTED`. |

## `redact`

`redact(span)` is called for every span Nestrix exports, after Nestrix's own redaction, and for every span the dashboard stores. It receives an editable copy with these fields:

| Field | Description |
|---|---|
| `name` | Read-only: edits are discarded. |
| `kind` | `SpanKind` as a number. Read-only. |
| `attributes` | Mutable. Delete a key to remove it, assign to rewrite it. |
| `events` | Each event has its own `name` and mutable `attributes` (an exception event's `exception.message` lives here). |
| `status` | Mutable. `status.code` is `SpanStatusCode` as a number (0 unset, 1 ok, 2 error); `status.message` is free text that often repeats an exception message. |

Return `false` to drop the span. It must be synchronous: a promise drops the span and counts a failure, as does a throw (fail closed). Links are not exposed; to keep them out, drop the span. It runs when a batch is exported, not in the request, so spans wait unredacted in the in-memory queue until then. It is not applied to what your exporters send when your app owns the SDK.

## `ui`

`ui` is `false` (no dashboard), `'auto'` (the same as `{}`) or an object. See [Security model](/guide/security).

| Option | Default | Description |
|---|---|---|
| `ui.enabled` | `'auto'` | `'auto'`: served only when `NODE_ENV` is `development` or unset, to loopback requests that carry the startup token cookie. `true`: served in any environment to requests that pass `auth`; without `auth` the dashboard stays off and an error is logged. `false`: off. |
| `ui.path` | `'/_nestrix'` | Where the dashboard is served, outside the global prefix and versioning. Starts with `/`; characters `A-Z a-z 0-9 . _ ~ / -`; not `/`, no empty, `.` or `..` segment. |
| `ui.auth` | none | `{ token }` or `{ authorize }`; not both. Required when `enabled` is `true`. With `'auto'` it applies in addition to the local-only rules. |
| `ui.auth.token` | none | At least 32 characters. Sent as `Authorization: Bearer <token>`, or exchanged once for a cookie at `<path>/auth?token=`. Compared in constant time. |
| `ui.auth.authorize` | none | `(request) => boolean \| Promise<boolean>`. Called for every dashboard request with the raw request, before any Nest guard. Only `true` allows; a throw, a rejection, any other value or no answer in 10 seconds denies. |
| `ui.startupToken` | `true` | `'auto'` mode only. `false` drops the startup token check and its log link; a same-host reverse proxy then exposes the dashboard when `NODE_ENV` is unset. |
| `ui.profiler` | `true` | The on-demand CPU [profiler](/guide/dashboard#profiler). Offered only where the dashboard is authenticated (`enabled: true`, or `'auto'` with the startup token or `auth`). `false` removes it and its routes. A non-boolean is an invalid `ui` value. |
| `ui.logs` | `true` | Keep `NestrixLogger` lines next to their trace in the dashboard store ([Logs next to the trace](/guide/dashboard)). `false` keeps none; the logger still prints and the correlation ids are unchanged. A non-boolean is an invalid `ui` value. |

## `store`

Ignored while the dashboard is off.

| Option | Default | Description |
|---|---|---|
| `store.maxTraces` | `5000` | Traces the dashboard keeps. Positive integer. |
| `store.maxBytes` | `33554432` (32 MiB) | Estimated bytes of stored spans. Positive integer. |

## `logs`

| Option | Default | Description |
|---|---|---|
| `logs.export` | `false` | Send `NestrixLogger` records over OTLP/HTTP to `/v1/logs` of the configured endpoint (`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is honoured, but does not turn export on by itself). Like metrics, it runs only when Nestrix owns the trace provider and trace export is on; with a host-owned SDK Nestrix registers no `LoggerProvider` and logs one line saying so. Needs `@opentelemetry/sdk-logs` and `@opentelemetry/exporter-logs-otlp-http`; without them one log line says so. |

## `metrics`

| Option | Default | Description |
|---|---|---|
| `metrics.runtime` | `true` | Event-loop delay, V8 heap, RSS and CPU time as observable instruments. They start only once a real `MeterProvider` is registered. `false` keeps the request histogram only. |
| `metrics.export` | `true` | Export over OTLP/HTTP from Nestrix's own `MeterProvider`, when Nestrix owns the tracer provider, an endpoint is set and `@opentelemetry/sdk-metrics` and `@opentelemetry/exporter-metrics-otlp-http` are installed. `false` keeps recording through the API, so a `MeterProvider` your app registers still receives the metrics. |

## Environment variables

| Variable | Effect |
|---|---|
| `NESTRIX_ENABLED` | `false` or `0` (any case) registers nothing at all. |
| `OTEL_SERVICE_NAME` | Default for `serviceName`. |
| `OTEL_RESOURCE_ATTRIBUTES` | `key=value,key2=value2`, merged into the resource; `resourceAttributes` wins. |
| `GIT_SHA` | The release (`service.version`) when no option or `OTEL_RESOURCE_ATTRIBUTES` sets one. |
| `npm_package_version` | The release when nothing above sets one. Set by `npm`/`pnpm run`, not by `node main.js`. |
| `NODE_ENV` | `ui: 'auto'` serves the dashboard only when it is `development` or unset. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base endpoint; `/v1/traces` is appended. Setting it switches export on. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full traces URL, used as given. Wins over the generic endpoint. |
| `OTEL_EXPORTER_OTLP_HEADERS` | `key=value,key2=value2`, values percent-decoded. |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | Same, for traces; wins over the generic variable key by key. |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Full logs URL, used as given. Only read when `logs.export` is on. |
| `OTEL_EXPORTER_OTLP_LOGS_HEADERS` | Same format, for logs. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Full metrics URL, used as given, when `export.otlp.endpoint` is not set. Does not switch export on by itself. |
| `OTEL_EXPORTER_OTLP_METRICS_HEADERS` | Same format, for metrics. |
| `OTEL_METRIC_EXPORT_INTERVAL` | Milliseconds between metric exports. Default `60000`; a value that is not a positive integer is ignored. |

An option always wins over the variable of the same meaning. Nestrix reads no other `OTEL_*` variables, but the OTLP exporter it uses reads some on its own: `OTEL_EXPORTER_OTLP_COMPRESSION` takes effect; `OTEL_EXPORTER_OTLP_TIMEOUT` and the certificate and key variables have no effect through Nestrix (use a collector or proxy in front for mutual TLS). When your app owns the SDK, the export variables are your SDK's business.

`OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`, `OTEL_SDK_DISABLED` and `OTEL_EXPORTER_OTLP_PROTOCOL` are not read: use `sampleRate` and `enabled` (or `NESTRIX_ENABLED`). Export is OTLP/HTTP with protobuf only.

## Stability

From 1.0, semantic versioning covers the exports of `@nestrix-js/nestjs`, the option names and their defaults, and the environment variables documented here. It does not cover the dashboard's query API (`/_nestrix/api/v1`) or the `@nestrix-js/protocol` types: they are internal to the bundled UI, which ships at the same version as the package. The names of the runtime metrics and the default set of traced classes may change in a minor release.
