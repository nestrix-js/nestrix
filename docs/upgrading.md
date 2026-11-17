# Upgrading from 0.x to 1.0

`0.1.0` is the first stable release of Nestrix on npm (the `latest` tag). Before it, `0.1.0-alpha.0` to `0.1.0-alpha.3` were prereleases under the `alpha` tag, and the `0.0.0` placeholders are deprecated. This page is for anyone who installed one of those prereleases, or builds from this repository, or followed the repository's own examples before 1.0. If you start with 0.1.0 or later, you can skip the renames below.

Everything below is a breaking change made before 1.0 on purpose (decision D-69, "1.0 API freeze decisions"): nothing stable was released, so nothing has a deprecation path. The old names are gone, not aliased. TypeScript reports the renamed options and types at compile time; the behaviour changes in the second section do not fail loudly, so read them.

From 1.0, semantic versioning covers the exports of `@nestrix-js/nestjs`, the option names and their defaults, and the documented environment variables. It does not cover the dashboard's query API (`/_nestrix/api/v1`) or the `@nestrix-js/protocol` types, which belong to the bundled UI, nor the names of the runtime metrics or the default set of traced classes (a minor release may change those).

Install `@nestrix-js/nestjs` and `@nestrix-js/ui` at the same version; they are released together.

## Requirements

### Node.js 26.13 or later

`engines` is `>=26.13.0` in both packages. Node 22 and 24 are no longer supported. Upgrade Node first (D-55).

### OpenTelemetry SDK 3 and API 1.10

Unchanged since 0.1, and still the most common install failure. `@opentelemetry/api` is a peer with the range `>=1.10.0 <1.11.0`, and a host on SDK 2 or API 1.9 must upgrade its OpenTelemetry packages first. Do not use `--legacy-peer-deps` or `--force`: a second API copy records spans nowhere, silently (D-40).

```bash
pnpm add @opentelemetry/api@~1.10.0
```

## Renamed and removed options

### `ignore.routes` is now `ignore.paths`

It matches literal request paths (what the client sent), not route templates, so the name now says so.

```ts
// before
NestrixModule.forRoot({ ignore: { routes: ["/health", /^\/internal\//] } });

// after
NestrixModule.forRoot({ ignore: { paths: ["/health", /^\/internal\//] } });
```

`ignore.outgoing` is unchanged.

### `methods.enabled` is gone: use `methods: false`

```ts
// before
NestrixModule.forRoot({ methods: { enabled: false } });

// after
NestrixModule.forRoot({ methods: false });
```

`methods` is now `false | { include?, exclude?, enhancers?, ... }`. Leave it out, or pass an object, to keep method spans on (they still need `instrument: NestrixInstrument` in `NestFactory.create`). `methods: { enabled: true }` becomes plain `methods: {}` or nothing.

### Type renames

| 0.x | 1.0 |
|---|---|
| `NestrixMethodOptions` | `NestrixMethodsOptions` |
| `NestrixIntegrationOptions` | `NestrixIntegrationsOptions` |

```ts
// before
import type { NestrixMethodOptions, NestrixIntegrationOptions } from "@nestrix-js/nestjs";

// after
import type { NestrixMethodsOptions, NestrixIntegrationsOptions } from "@nestrix-js/nestjs";
```

The plural names match the option keys (`methods`, `integrations`).

### `SpanOptions` is no longer exported

`@nestrix-js/nestjs` stopped re-exporting the OpenTelemetry type. Import it from the API, which is already a peer dependency.

```ts
// before
import { type SpanOptions, withSpan } from "@nestrix-js/nestjs";

// after
import type { SpanOptions } from "@opentelemetry/api";
import { withSpan } from "@nestrix-js/nestjs";
```

### `user`, `authorize` and `redact` callbacks

These widen what you may write, so existing code keeps compiling.

- `user` and `ui.auth.authorize` accept a callback whose parameter you type yourself, with no cast:

  ```ts
  // before
  user: (request) => (request as { user?: { id?: string } }).user?.id,

  // after
  user: (request: { user?: { id?: string } }) => request.user?.id,
  ```

- `RedactHook` may now return `void` as well as `boolean`. A hook that returns nothing keeps the span.

## Behaviour changes

### Logs and metrics export only when Nestrix owns the trace provider

One rule for all three signals (D-69 (1)): the host's OpenTelemetry SDK owns every signal. Nestrix starts its own metric and log exporters only when it created the trace provider (you registered none before `NestFactory.create`) and trace export is on.

What changes for you:

- **Host with its own SDK.** In 0.x builds, `logs: { export: true }` could create a Nestrix `LoggerProvider` next to your SDK. In 1.0 it does not: Nestrix logs one line saying so and sends no log records. Register the log (and metric) exporters in your own SDK. `NestrixLogger` still adds `trace_id` and `span_id` to log lines, and the request-duration and runtime metrics still go to your `MeterProvider` through `@opentelemetry/api`.
- **`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` alone no longer turns log export on.** Set `logs: { export: true }` as well. The variable still selects where logs go once it is on.
- **`export: { otlp: false }` turns off traces, logs and metrics together.** The same `endpoint` and `headers` feed `/v1/traces`, `/v1/logs` and `/v1/metrics`.

```ts
NestrixModule.forRoot({
  logs: { export: true }, // needs @opentelemetry/sdk-logs and exporter-logs-otlp-http
  metrics: { runtime: true }, // metric export needs sdk-metrics and exporter-metrics-otlp-http
});
```

### Exported metrics now carry `service.version`

A fix: the resource on exported metrics lacked the value that traces had. If you built dashboards or alerts on metrics without that attribute, check any grouping that now splits by version.

### Metrics recording and the owned meter provider

The owned meter provider starts at bootstrap, so a `MeterProvider` your app registers in `onModuleInit` takes precedence. The request histogram has gained `url.scheme`. Metric names may change in a minor release (see above), so pin dashboards to them knowing that.

### Export failures are logged, and metrics stop at an endpoint that does not take them

New in 0.5 (D-82). When Nestrix owns the pipeline, an export that starts failing (backend down, key refused, rate limited) logs one warning through Nest's `Logger` (context `Nestrix`), and one line when it recovers; before, nothing was logged. A metrics URL that answers 404, 405 or 501 (the Nestrix standalone server, which now answers 404 there instead of 403) gets one line, and Nestrix stops exporting metrics until the app restarts; traces and logs continue. If you filtered OpenTelemetry's diag output to find export errors, read these lines instead.

New export: `getExportStatus()`, a read-only snapshot per signal (state, last success and failure, reason and HTTP status, consecutive failures, totals by reason, items dropped from the queue), plus two observable counters on the registered `MeterProvider`, `nestrix.export.failures{signal,reason}` and `nestrix.export.dropped{signal}`. With a host-owned SDK nothing changes: the status stays `inactive` and no instrument is added. Use the status in readiness checks as "degraded", never as a reason to restart (the "Export health" sections of the package README and of the logs and metrics guide show how).

### Standard OpenTelemetry sampler and protocol variables are not read

`OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`, `OTEL_SDK_DISABLED` and `OTEL_EXPORTER_OTLP_PROTOCOL` have no effect in 1.x. Use the `sampleRate` option, and `enabled: false` or `NESTRIX_ENABLED=false` to switch Nestrix off. Export is OTLP/HTTP with protobuf only. A new 1.0 install is not affected, but a config copied from another OpenTelemetry setup will not behave as it did there.

## Added

### `emitLog()`: logs from your own logger

Until now only `NestrixLogger` lines were exported to `/v1/logs` and kept next to their trace. `emitLog({ level, message, context?, error?, attributes? })` sends a record from any logger through the same path and rules (D-89): call it from your `ConsoleLogger` subclass's print path, or from a pino destination, with the message your logger already redacted. Nothing changes for apps that do not call it, and `NestrixLogger` behaves as before. See [Logs from your own logger](../packages/nestjs/README.md#logs-from-your-own-logger).

## The bundled UI and the query API

The dashboard's query API and `@nestrix-js/protocol` are internal to the UI, which ships at the same version. The 0.x renames below matter only if you called `/_nestrix/api/v1` yourself or built against the protocol types. Nothing public changed.

- `SpanRecord.service` was added, and `MetaResponse.mode` (`embedded` or `standalone`) is now required.
- `statistics.windowsMinutes` is now `windowMinutesOptions`.

Pin the UI to the same version as `@nestrix-js/nestjs`, and do not script against these endpoints.

## Unchanged, but easy to miss

- ESM-only. CommonJS Nest 12 apps load the package with `require()`; no top-level `await` is used in anything an entry point imports.
- `store` stays a top-level option; `ui` still has its three states (`'auto'`, `false`, `{ enabled: true, auth }`).
- Privacy defaults: no request or response bodies, no bind parameters, no headers outside the allowlist.
- The dashboard is closed unless something positive opens it, and its API never emits CORS headers.
- BullMQ: pass `telemetry: bullmqTelemetry({ tracerName })` (exported by `@nestrix-js/nestjs` since 0.5) instead of `new BullMQOtel(...)`. In an ESM app a `BullMQOtel` created in `BullModule.forRoot()` records no BullMQ span at all, silently (issue #20, D-81); the README's "Background jobs" section shows how to keep `bullmq-otel` if you must.

## Checking the upgrade

1. `tsc --noEmit`: the renamed options and types fail here.
2. Start the app and read Nestrix's startup log lines. A conflicting host SDK, a missing optional package for an exporter and an unreadable option each produce exactly one line.
3. Open the dashboard link logged at startup, or confirm in your backend that traces, logs and metrics arrive. If logs or metrics vanished after the upgrade, the first behaviour change above is the likely cause.
