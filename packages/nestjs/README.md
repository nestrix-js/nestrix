# @nestrix/nestjs

Nest-aware OpenTelemetry tracing for NestJS 12+. Add one module and your app produces a server span per request, outgoing HTTP spans, and your own spans, exported over OTLP to whatever backend you run (Jaeger, Tempo, an OpenTelemetry Collector, a vendor that accepts OTLP).

> **Status: 0.1.0-alpha.** Tracing with OTLP export, and an embedded dashboard served by your own app. The `instrument` hook for controller, guard and job spans, library spans (`pg`, `mysql2`, `ioredis`) and microservice spans come in later releases. Option names may still change before 1.0.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Dashboard](#dashboard)
- [Options](#options)
- [Environment variables](#environment-variables)
- [What is traced](#what-is-traced)
- [Custom spans](#custom-spans)
- [Logs](#logs)
- [Privacy](#privacy)
- [Shutdown and flushing](#shutdown-and-flushing)
- [Supported versions](#supported-versions)
- [OpenTelemetry SDK 3 only](#opentelemetry-sdk-3-only)
- [Using it next to other tools](#using-it-next-to-other-tools)
- [CommonJS apps](#commonjs-apps)
- [Install size and startup cost](#install-size-and-startup-cost)

## Install

```bash
pnpm add @nestrix/nestjs @opentelemetry/api@~1.10.0
```

`@opentelemetry/api` is a peer dependency, so your app and Nestrix share one copy. Nestrix needs NestJS 12, `reflect-metadata` and `rxjs`, which a Nest app already has. `@nestjs/microservices` and `pg` are optional peers that this release does not use yet.

The dashboard is a separate, optional package, installed at the same version as `@nestrix/nestjs`; see [Dashboard](#dashboard).

```bash
pnpm add @nestrix/ui
```

The package is ESM-only. A CommonJS Nest 12 app loads it with `require()`; see [CommonJS apps](#commonjs-apps).

## Quick start

Register the module once, in your root module. It is global: every other module gets it without importing it.

<!-- sample: for-root -->

```ts
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix/nestjs";

@Module({
  imports: [
    // Import NestrixModule before modules that register global interceptors.
    NestrixModule.forRoot({ serviceName: "my-api" }),
  ],
})
export class AppModule {}
```

Import `NestrixModule` before other modules that register a global interceptor (`APP_INTERCEPTOR`). Nest runs global interceptors in module order, and an interceptor that runs before Nestrix's can throw an error that Nestrix never sees: the request's span then has no route name for a 404 and no exception event.

With no configuration Nestrix creates spans and keeps them in memory, but **exports nothing**: OTLP export is on only when an endpoint is set, by option or by environment. At startup Nestrix logs one line saying so. To export, set an endpoint:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node dist/main.js
```

`/v1/traces` is appended to the endpoint. Spans leave the process in batches, in the background, through a bounded queue; nothing in a request waits on the collector. When the queue is full new spans are dropped and counted.

### `forRootAsync`

Use `forRootAsync` when options come from another provider. `useFactory` may be async and receives what `inject` lists, in order.

<!-- sample: for-root-async -->

```ts
import { Injectable, Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix/nestjs";

@Injectable()
class Settings {
  readonly otlpEndpoint = process.env.COLLECTOR_URL;
}

@Module({ providers: [Settings], exports: [Settings] })
class SettingsModule {}

@Module({
  imports: [
    NestrixModule.forRootAsync({
      imports: [SettingsModule],
      inject: [Settings],
      useFactory: (settings: Settings) => ({
        serviceName: "my-api",
        export: { otlp: { endpoint: settings.otlpEndpoint } },
      }),
    }),
  ],
})
export class AppModule {}
```

With `forRootAsync`, an `enabled: false` returned from the factory disables Nestrix, but the module's providers are still registered and do nothing. With `forRoot`, `enabled: false` registers nothing at all.

### A host that already runs an OpenTelemetry SDK

If your app registers its own tracer provider before Nestrix starts (that is, before `NestFactory.create` constructs the module), Nestrix does not create an SDK. Its spans go through your provider and your exporters. In that case `serviceName`, `resourceAttributes`, `OTEL_RESOURCE_ATTRIBUTES`, `sampleRate`, every `export.*` option and, for what your exporters send, `redact` are ignored (the resource, sampler, exporters and redaction are your SDK's; see [Privacy](#privacy)), and Nestrix logs one line saying so. `ignore`, `http`, `ui` and `store` still apply, and so does `redact` for the copy of each span the dashboard keeps. To see your spans in the dashboard, add `nestrixSpanProcessor()` to your provider ([below](#a-host-that-owns-its-sdk)). Your SDK must be OpenTelemetry JS SDK 3.

**Several Nestrix apps in one process** (an e2e suite, for example) share what the first one set up: its `export`, `sampleRate`, resource and `redact` settings, and the outbound `ignore.outgoing` and `http` settings. Later apps' values for those are ignored; Nestrix logs one line when that happens.

Nestrix registers its OpenTelemetry globals during `NestFactory.create`, never at import time or when `forRoot()` runs. If you start your SDK in the body of `main.ts` after importing `AppModule`, start it before `NestFactory.create`.

## Dashboard

With `@nestrix/ui` installed, `NestrixModule` serves a read-only dashboard from inside your app, at `/_nestrix` by default: recent requests, one request's spans as a waterfall, errors, and per-route request counts, error rates and latency percentiles. It polls for new data every two seconds. It works on Express, Fastify and `@nestjs/platform-node`. It shows only what this process has seen since it started; nothing is written to disk and nothing is sent anywhere.

```bash
pnpm add @nestrix/ui
```

`@nestrix/ui` is an optional peer dependency. Install it at the same version as `@nestrix/nestjs`. Without it the dashboard is off and Nestrix logs one line with the install command; the app starts normally. An app with no HTTP adapter (`createMicroservice`, `createApplicationContext`) has no dashboard, and says nothing about it.

The dashboard is closed unless something positive opens it. There are two ways to open it: `ui: 'auto'` for development, and `ui: { enabled: true, auth }` for everything else.

### Development: `ui: 'auto'`

`ui` defaults to `'auto'`, so installing the package is enough. In this mode the dashboard is served only while all of these hold:

- `NODE_ENV` is `development` or unset. Any other value, an empty string included, turns it off for the whole run, and Nestrix logs one line that says so.
- The request's socket peer is loopback (`127.0.0.0/8`, `::1`, `::ffff:127.x.y.z`), its `Host` header names a loopback host (`localhost`, `127.x.y.z` or `[::1]`, with or without a port), and none of `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP` and `Via` is present. Nestrix reads these from the raw socket and raw headers, never from `req.ip` or `req.hostname`, which follow client-supplied headers when your app trusts proxies.
- The request carries the startup token cookie (below).

A request that fails any other check gets a bare `404` with an empty body. The one exception is a loopback request without the cookie, which gets a `403` page telling you to open the link from the log.

**The startup token.** When the app starts listening, Nestrix logs one line:

```text
Nestrix dashboard: http://localhost:3000/_nestrix/auth?token=<43 characters>
```

Open that link in your browser. Nestrix checks the token, sets a session cookie and redirects to `/_nestrix/`, so the token does not stay in the address bar. The cookie is `HttpOnly`, `SameSite=Strict`, scoped to the dashboard path, and named `nestrix_session_<port>` after the port the app listens on, so two apps on `localhost` with different ports do not overwrite each other's cookie. Each start creates a new token: after a restart, open the new link. If the app never calls `listen()`, the line says the link needs a listening server. The link is accepted only from loopback requests.

**Why it exists.** The loopback checks cannot tell a browser on your machine from a reverse proxy on the same host. nginx's usual `proxy_pass http://127.0.0.1:3000` adds no forwarding header and rewrites `Host`, so every request through it looks local; with `NODE_ENV` unset, that would put the dashboard on the internet. The proxy's visitors do not have the token, so with it the dashboard stays closed (the proxy case was run against a real proxy in the phase 0 spike, and a test covers it). Set `NODE_ENV` in deployed environments anyway.

**Opting out.** `ui: { startupToken: false }` drops the token check and the log link. The consequence: the same-host reverse proxy above is open again whenever `NODE_ENV` is unset. Use it only when the app is never behind a proxy on its own host, or when `NODE_ENV` is always set.

### Production: `ui: { enabled: true, auth }`

<!-- sample: dashboard-token -->

```ts
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix/nestjs";

@Module({
  imports: [
    NestrixModule.forRoot({
      ui: {
        // Required to serve the dashboard outside development. At least 32 characters.
        enabled: true,
        auth: { token: process.env.NESTRIX_UI_TOKEN ?? "" },
        // Default "/_nestrix". Outside the global prefix and versioning.
        path: "/_nestrix",
      },
    }),
  ],
})
export class AppModule {}
```

With `enabled: true` the dashboard is served in any environment to requests that pass `auth`, and to nobody else. There is no loopback or `NODE_ENV` check. `enabled: true` without `auth` leaves the dashboard off, logs an error and starts the app. So does any invalid `ui` value (a path with a forbidden character, a token under 32 characters, both `token` and `authorize`): unlike the other options, `ui` never throws at startup.

**`auth: { token }`.** At least 32 characters; `openssl rand -base64 32` makes a good one. It is compared in constant time.

- Tools send `Authorization: Bearer <token>` on each request.
- Browsers open `https://your-host/_nestrix/auth?token=<token>` once. Nestrix sets a session cookie (`nestrix_auth_<port>`, `HttpOnly`, `SameSite=Strict`, `Secure` unless the request came from loopback) and redirects to the dashboard. **That link puts the token in the URL, so it lands in the access logs of every proxy and load balancer it passes through and in the browser's history.** Prefer the `Authorization` header for tools, open the link only over a connection whose logs you control, and rotate the token if it leaked. The cookie value is salted per process, so it stops working after a restart.

**`auth: { authorize(request) }`.**

<!-- sample: dashboard-authorize -->

```ts
import type { IncomingHttpHeaders } from "node:http";
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix/nestjs";

// Your own check, for example a verified session or an identity-aware proxy's signed header.
declare function isOperator(
  authorization: string | undefined,
): Promise<boolean>;

@Module({
  imports: [
    NestrixModule.forRoot({
      ui: {
        enabled: true,
        auth: {
          // `request` is the raw adapter request (Express `req`, Fastify `request`,
          // platform-node's request). No Nest guard has run, so `request.user` is not set.
          authorize: async (request) => {
            const { headers } = request as { headers: IncomingHttpHeaders };
            return isOperator(headers.authorization);
          },
        },
      },
    }),
  ],
})
export class AppModule {}
```

`authorize` is called for every dashboard request and may be async. It receives the raw, adapter-specific request **before any Nest guard, pipe or interceptor has run**, so `request.user`, which a Passport guard sets, is not populated: read the headers or cookies yourself and verify them. Only `true` allows. A throw, a rejection, any other value, or no answer within 10 seconds denies. It is not called for requests rejected by the cheaper checks (`Sec-Fetch-Site: cross-site`).

With `enabled: 'auto'` (or no `enabled`) and an `auth`, both apply: the local-only rules, the startup token and `auth`.

Every mode that serves the dashboard also rejects requests with `Sec-Fetch-Site: cross-site`. A denied request always gets the bare `404`: the default path is well known, so this hides detail, not existence.

### Path, global prefix and host layers

`ui.path` defaults to `/_nestrix`. It must start with `/`; one trailing `/` is removed; only `A-Z a-z 0-9 . _ ~ / -` are allowed; it cannot be `/` or contain an empty, `.` or `..` segment. An invalid path leaves the dashboard off with an error in the log.

Nestrix registers the dashboard's routes with the HTTP adapter's own `get` during `onModuleInit`. So they sit **outside the global prefix and URI versioning** (`setGlobalPrefix('api')` does not move them) and outside guards, pipes and interceptors. Host middleware, `helmet`, `compression`, `enableCors()` and `app.useSecurityHeaders()` still apply to them. The dashboard sets its own `Content-Security-Policy` and its other security headers on every response except the bare 404 of a denied request, replacing the host's values, and it removes any `Access-Control-*` header a host layer added, on every response.

Requests under the dashboard path get no span and no route statistic, so the dashboard polling itself does not fill the store. The path is matched case-insensitively for this. The dashboard reads a JSON API under `<path>/api/v1`; every route is `GET`.

### A host that owns its SDK

If your app registers its own OpenTelemetry provider before Nestrix starts, Nestrix cannot add a processor to it. Add `nestrixSpanProcessor()` to the provider's `spanProcessors` yourself:

<!-- sample: dashboard-host-sdk -->

```ts
import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { nestrixSpanProcessor } from "@nestrix/nestjs";

// Your own SDK setup, started before NestFactory.create.
trace.setGlobalTracerProvider(
  new TracerProvider({
    spanProcessors: [
      new BatchSpanProcessor({ exporter: new OTLPTraceExporter() }),
      // Feeds the dashboard's store. It stores nothing while the dashboard is off.
      nestrixSpanProcessor(),
    ],
  }),
);
```

If you have not added it, Nestrix logs one line at startup saying so, and until the first span reaches the store the dashboard shows the same warning. The processor sees every recording span in your provider, other instrumentations' included. It never throws, and its `forceFlush` and `shutdown` never reject. It stores nothing while no Nestrix app with the dashboard on is running in the process. Route statistics do not need it: they are counted in Nestrix's request hook. Your SDK must be OpenTelemetry JS SDK 3.

### Sampling and route statistics

Per-route statistics (the Routes view) count **every request**, whatever the sample rate and whether Nestrix or your own SDK does the sampling. They are counted when the response closes, before the sampling decision matters. Requests excluded by `ignore.routes` and requests to the dashboard itself are not counted.

- A statistic is keyed by `METHOD route-template`, for example `GET /users/:id`. A request no route matched is `METHOD (unmatched)`.
- Each key keeps one-minute buckets for the last 60 minutes: request count, error count, and a duration histogram that gives p50, p95 and p99 (30 log-spaced buckets from 1 ms to 60 s, so a percentile is accurate to a bucket, not exact).
- At most 500 keys are tracked; further routes are counted together under `* (other)` (method `*`, route `(other)`).

The request list and the error list come from stored spans, so they **are sampled**. The dashboard says so when `sampleRate` is below 1, and says they may be when your SDK owns the sampler. At `sampleRate: 0.1`, the Routes view shows every request and the list shows about one in ten.

**What is an error.** A span is an error when its status code is `error`. For a server span that means a 5xx response, or a handler exception that maps to 5xx. A thrown `NotFoundException` (404) keeps its exception event in the trace detail but counts as no error in route statistics, the error list or the error filter. The error list holds every stored span with error status, client spans and your own spans included.

### When something else answers first (shadowing)

A host route can answer a request under the dashboard path before Nestrix's route sees it: a catch-all route on Express, or `@nestjs/serve-static`'s fallback on Express and platform-node. Nest has no public route table, so Nestrix detects it passively: the first time a `GET` or `HEAD` under the dashboard path is answered, with a status other than 404, without a dashboard handler having run, it logs one line per process.

- With status 401, 403 or 429: `Nestrix dashboard: a request under /_nestrix was answered by host middleware before the dashboard (status 401). ...`. Your auth gate or rate limiter applies to the dashboard too; let requests under that path through.
- Otherwise: `Nestrix dashboard: /_nestrix is shadowed by a host route (a catch-all, or @nestjs/serve-static's fallback): ...`. Fix it in one of these ways. Exclude the dashboard path from that route (for `@nestjs/serve-static`, its `exclude` option, which is what the log line suggests), or set `ui.path` to another path. If the catch-all is a controller route, a global prefix keeps it off the dashboard path, because the dashboard sits outside the prefix. For `@nestjs/serve-static`, the phase 0 spike found it shadows the dashboard when its module initialises first, which followed import order there; importing it after `NestrixModule` may help (not re-tested for this README).

The line appears only after someone opens the dashboard, which is when it matters. Fastify was not affected in the spike.

### Cross-origin pages and CORS

The dashboard never sends CORS allow headers, whatever your CORS setup. Preflight (`OPTIONS`) requests, though, are answered by your CORS layer, not Nestrix, with your allow headers. So a page on another origin could send a request to the dashboard but could not read the answer, and in `'auto'` mode the cookie is `SameSite=Strict`. The API is read-only, so this is a known limit and not a hole; it would need its own protection if the dashboard ever gained an endpoint that changes state.

### Memory and the `store` option

The dashboard keeps recent traces in memory, bounded by two limits, and the oldest trace (the one whose first span arrived earliest, with its error items) is evicted first when either is reached. Nothing is written to disk. While the dashboard is off, nothing is stored.

<!-- sample: dashboard-store -->

```ts
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix/nestjs";

@Module({
  imports: [
    NestrixModule.forRoot({
      store: {
        // The dashboard keeps whichever limit is reached first, oldest trace evicted first.
        maxTraces: 500,
        maxBytes: 16 * 1024 * 1024,
      },
    }),
  ],
})
export class AppModule {}
```

- `maxTraces` counts traces held, listed or not. `maxBytes` is an **estimate** of the heap the stored spans use, computed as each span is copied (not by serialising it). It was measured at 1.12 to 1.22 times the real heap growth for the three trace shapes below, so real use is below the estimate. A single span estimated larger than `maxBytes` is dropped and logged once.
- Defaults: `maxTraces` 5,000 and `maxBytes` 32 MiB. Measured on darwin-arm64 with Node 26 (`benchmarks/results/dashboard.md`): a trace of one server span holds about 1.4 KB of heap, a server span plus five client spans (a typical request) about 4.0 KB, and a trace of 51 spans with attributes and an exception about 27.8 KB. A full store therefore holds about 7 MiB (single-span traces), 19.5 MiB (typical traces, stopped by `maxTraces`) or 28 MiB (51-span traces, about 1,050 of them, stopped by `maxBytes`) of heap. Your traces may be larger or smaller; if the dashboard should reach further back, raise `maxTraces` and watch your own heap.
- Cost per request, with the dashboard on and export off, saturating one core: about 6 microseconds more per request (throughput 15% lower on a route that costs about 36 microseconds without it; a handler that calls a database costs a thousand or more). Route statistics are about 70 ns of that; the rest is copying the span into the store. Live heap with a full store of single-span traces was 10.5 MB higher than with the dashboard off. These were measured with the dashboard page closed; it adds the requests it makes while open.
- Beyond the store: a bounded queue of spans waiting to be copied (at most 4,096; a burst beyond that is dropped and counted), and the route statistics (typed arrays per key, at most 500 keys).
- There is one store per process. The first Nestrix app to create it sets its limits, and a later app's different `store` option is ignored with one log line. A store that `nestrixSpanProcessor()` created first still takes the module's limits, if no span has reached it yet.

### What the dashboard shows

The dashboard shows the spans in its store, and the [privacy defaults](#privacy) apply to them: no request or response bodies, no query bind parameters and no headers outside the allowlist. Nestrix's own redaction (listed query keys, the always-redacted headers, credentials in `url.full`) and your `redact` hook run on every span before it is stored, **including spans from other instrumentations**; a span `redact` drops never reaches the dashboard. This holds when your app owns the SDK too: the dashboard's copy is redacted, while your own exporters still get the span as it was.

Redaction runs shortly after the span ends, not in the request, so a span waits unredacted in a small in-memory queue until then. Free text is not cleaned by key: exception messages, stack traces and status messages are stored and shown as they are, and another instrumentation may record attributes Nestrix does not know about. Use `redact` for those, and look at what the dashboard shows in development before you enable it elsewhere.

## Options

Every option is optional. `NestrixModule.forRoot(options?)` and the object `forRootAsync`'s factory returns take the same shape. Invalid values (for example a `sampleRate` outside 0 to 1, or a non-positive queue size) throw. With `forRoot`, that happens when `forRoot()` is called, which is when your module file loads, and also with `enabled: false`. With `forRootAsync`, it happens when the factory's result is resolved during `NestFactory.create`. `export.otlp.timeoutMillis` is validated only when an endpoint resolves.

The package exports these types: `NestrixModuleOptions`, `NestrixModuleAsyncOptions`, `NestrixExportOptions`, `NestrixOtlpOptions`, `NestrixQueueOptions`, `NestrixIgnoreOptions`, `NestrixHttpOptions`, `RedactHook`, `RedactableSpan`, `UrlMatcher`, `SpanOptions`, `NestrixUiOptions`, `NestrixUiTokenAuth`, `NestrixUiCustomAuth` and `NestrixStoreOptions`. The package also exports the function `nestrixSpanProcessor`.

<!-- sample: all-options -->

```ts
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix/nestjs";

@Module({
  imports: [
    NestrixModule.forRoot({
      enabled: true,
      serviceName: "my-api",
      resourceAttributes: { "deployment.environment.name": "production" },
      sampleRate: 0.25,
      export: {
        otlp: {
          endpoint: "http://otel-collector:4318",
          headers: { authorization: "Bearer my-token" },
          timeoutMillis: 10_000,
        },
        queue: {
          maxQueueSize: 2048,
          maxExportBatchSize: 512,
          scheduledDelayMillis: 5000,
        },
      },
      ignore: {
        routes: ["/health", /^\/metrics/],
        outgoing: ["https://o123.ingest.sentry.io/"],
      },
      http: {
        requestHeaders: ["x-correlation-id"],
        responseHeaders: ["cache-control"],
        redactQueryKeys: ["ticket"],
      },
      redact: () => undefined,
    }),
  ],
})
export class AppModule {}
```

That sample sets most options to their defaults, except where a default is "unset". The reference follows.

### Top level

| Option | Default | |
|---|---|---|
| `enabled` | `true` | `false` registers nothing at all. `NESTRIX_ENABLED=false` (or `0`) in the environment does the same and wins over `enabled: true`: it is a kill switch. |
| `serviceName` | `OTEL_SERVICE_NAME`, then the SDK's default | The `service.name` resource attribute. |
| `resourceAttributes` | none | Extra resource attributes. `OTEL_RESOURCE_ATTRIBUTES` is honoured too; these win. |
| `sampleRate` | `1` | Head sampling ratio for new root traces, 0 to 1. Implemented as a parent-based ratio sampler, so an incoming sampled `traceparent` is honoured whatever the ratio. Ignored when your app owns the SDK. |
| `export` | see below | Export settings. |
| `ignore` | none | Requests that get no span. |
| `http` | none | Extra allowlisted headers and redacted query keys. |
| `redact` | none | A synchronous hook that sees every exported span and every span the dashboard stores. |
| `ui` | `'auto'` | The embedded dashboard: `false`, `'auto'` or an object. See [Dashboard](#dashboard) and [`ui`](#ui). |
| `store` | see below | Limits of the dashboard's in-memory store. See [`store`](#store). |
| `logs` | `{ export: false }` | Log export over OTLP. See [Logs](#logs). |
| `logs.export` | `false` | Send `NestrixLogger` records over OTLP to `/v1/logs`. Needs `@opentelemetry/sdk-logs` and `@opentelemetry/exporter-logs-otlp-http`. See [Logs](#logs). |

### `export.otlp`

| Option | Default | |
|---|---|---|
| `export.otlp` | an object, or `false` | `false` turns OTLP export off even when the environment sets an endpoint. |
| `export.otlp.endpoint` | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (used as given), then `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL such as `http://localhost:4318`; `/v1/traces` is appended. With no endpoint anywhere, nothing is exported. |
| `export.otlp.headers` | `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | Headers sent with every export request, for example an API key. The option wins over both variables, key by key; the traces variable wins over the generic one. |
| `export.otlp.timeoutMillis` | `10000` | Timeout per export request. Positive integer. |

### `export.queue`

| Option | Default | |
|---|---|---|
| `export.queue` | an object | The buffer between your app and the exporter. |
| `export.queue.maxQueueSize` | `2048` | Spans buffered before new ones are dropped (and counted). |
| `export.queue.maxExportBatchSize` | `512` | Spans per export request. Must not exceed `maxQueueSize`. |
| `export.queue.scheduledDelayMillis` | `5000` | How often a partial batch is exported. A full batch is exported at once. |

All three must be positive integers.

### `ignore`

| Option | Default | |
|---|---|---|
| `ignore.routes` | none | Incoming requests that get no server span. Matched against the request path without the query string. A string must equal the path exactly: `"/health"` does not match `"/health/live"`. |
| `ignore.outgoing` | none | Outgoing requests that get no client span and no `traceparent` header. Matched against the recorded `url.full` (credentials removed, listed query values already `REDACTED`). A string is a **prefix**, for example `"https://o123.ingest.sentry.io/"`. |

A matcher is a string, a `RegExp` or a function. In `ignore.routes` a `RegExp` is applied with `search`, so the `g` flag and `lastIndex` do not matter. In `ignore.outgoing` its `lastIndex` is reset to 0 and `test` is called. A function receives the path or URL and must return `true` to match. A matcher that throws counts as a match, and the failure is counted. Counts are internal for now: there is no public accessor, and drops because the queue is full are counted but not logged.

<!-- sample: ignore -->

```ts
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix/nestjs";

@Module({
  imports: [
    NestrixModule.forRoot({
      ignore: {
        // A string matches the request path exactly: "/health" does not match "/health/live".
        routes: ["/health", /^\/health\//, (path) => path.endsWith(".map")],
        // A string is a prefix of the recorded url.full. Add your error reporter's ingest host.
        outgoing: ["https://o123.ingest.sentry.io/", /\/internal\//],
      },
    }),
  ],
})
export class AppModule {}
```

An ignored request gets no Nestrix span, but other tools' spans inside it are not suppressed.

### `http`

These add to the privacy defaults below; they never replace them.

| Option | Default | |
|---|---|---|
| `http.requestHeaders` | none | Extra request headers recorded as `http.request.header.<name>`. |
| `http.responseHeaders` | none | Extra response headers recorded as `http.response.header.<name>`. |
| `http.redactQueryKeys` | none | Extra query-string keys whose values are replaced by `REDACTED`. |

### `redact`

A hook for the spans Nestrix exports and the spans the dashboard stores. See [Privacy](#privacy).

### `ui`

`ui` is `false` (no dashboard), `'auto'` (the same as `{}`) or an object. Everything about what these do is in [Dashboard](#dashboard).

| Option | Default | |
|---|---|---|
| `ui` | `'auto'` | `false` turns the dashboard off: no routes, no store, no route statistics. |
| `ui.enabled` | `'auto'` | `'auto'`: served only when `NODE_ENV` is `development` or unset, to loopback requests that carry the startup token cookie. `true`: served in any environment to requests that pass `auth`; without `auth` the dashboard stays off and an error is logged. `false`: off. |
| `ui.path` | `'/_nestrix'` | Where the dashboard is served, outside the global prefix and versioning. Starts with `/`; characters `A-Z a-z 0-9 . _ ~ / -`; not `/`, no empty, `.` or `..` segment. |
| `ui.auth` | none | `{ token }` (at least 32 characters; `Authorization: Bearer`, or the `<path>/auth?token=` link once per browser) or `{ authorize(request) }` (async allowed; the raw request, before any Nest guard; only `true` allows). Required when `enabled` is `true`. With `'auto'` it applies in addition to the local-only rules. |
| `ui.startupToken` | `true` | `'auto'` mode only. `false` drops the startup token check and its log link; a same-host reverse proxy then exposes the dashboard when `NODE_ENV` is unset. |

An invalid `ui` value (wrong type, bad path, short token, both `token` and `authorize`) turns the dashboard off and logs an error; it does not throw.

### `store`

| Option | Default | |
|---|---|---|
| `store.maxTraces` | `5000` | Traces the dashboard keeps. Positive integer. |
| `store.maxBytes` | `33554432` (32 MiB) | Estimated bytes of stored spans. Positive integer. |

Ignored while the dashboard is off. See [Memory and the `store` option](#memory-and-the-store-option).

## Environment variables

| Variable | Effect |
|---|---|
| `NESTRIX_ENABLED` | `false` or `0` (any case) registers nothing at all. |
| `OTEL_SERVICE_NAME` | Default for `serviceName`. |
| `OTEL_RESOURCE_ATTRIBUTES` | `key=value,key2=value2`, merged into the resource; `resourceAttributes` wins. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base endpoint; `/v1/traces` is appended. Setting it switches export on. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full traces URL, used as given. Wins over the generic endpoint. |
| `OTEL_EXPORTER_OTLP_HEADERS` | `key=value,key2=value2`, values percent-decoded. |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | Same, for traces; wins over the generic variable key by key. |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Full logs URL, used as given. Only read when `logs.export` is on. |
| `OTEL_EXPORTER_OTLP_LOGS_HEADERS` | Same format, for logs; wins over the generic variable key by key. |

An option always wins over the variable of the same meaning. Nestrix itself reads no other `OTEL_*` variables, but the OTLP exporter it uses reads some on its own:

- `OTEL_EXPORTER_OTLP_COMPRESSION` and `OTEL_EXPORTER_OTLP_TRACES_COMPRESSION` take effect (read by `@opentelemetry/otlp-exporter-base` 0.301.1; found in its source, not run through Nestrix).
- `OTEL_EXPORTER_OTLP_TIMEOUT` has no effect: Nestrix always passes `timeoutMillis` (default 10000).
- `OTEL_EXPORTER_OTLP_CERTIFICATE`, `…_CLIENT_CERTIFICATE` and `…_CLIENT_KEY` (and their `_TRACES_` forms) have no effect through Nestrix: the exporter uses them only to build its default HTTP agent, and Nestrix supplies its own agent factory, which wins in the exporter's configuration merge. Use a collector or proxy in front for mutual TLS.

When your app owns the SDK, the export variables are your SDK's business, not Nestrix's.

## What is traced

- **Incoming HTTP.** One server span per request, named `METHOD /route/template` (or `METHOD` when no route matched, as for a 404), with the OpenTelemetry HTTP attributes, `code.function.name` (`Controller.handler`), the status, and the first exception a handler or pipe threw as an exception event. An incoming `traceparent` is continued. If the client goes away before the response finishes, the span carries `nestrix.http.aborted = true`.
- **Outgoing HTTP.** `node:http` and `fetch` (undici) calls get a client span named `METHOD`, and a `traceparent` header unless the request already has one. A request made with no active parent span gets no span and no header, so background traffic (a health poller, an error reporter's transport outside a request) is not traced. If the response body is never read, the span ends at the response head and carries `nestrix.http.body = "not consumed"`: for `node:http`, on the next turn of the event loop if nothing is reading; for `fetch` and undici, after 30 seconds. The 30 seconds restart with each body chunk. A `node:http` caller that starts reading on a later tick also gets a head-only span. A body the caller cancels after the response head is marked `"cancelled"` and is not an error. A request whose method is not in the HTTP conventions' list gets the span name `HTTP` and `http.request.method = "_OTHER"`; this applies to server spans too.
- **Exceptions.** A handler's or pipe's exception is recorded on the server span. An exception thrown by a guard is not: guards run before Nestrix's interceptor, so a guard rejection keeps its route name and records no exception event.
- **Process errors.** An uncaught exception becomes an exception event on the active request span, or a short span of its own. An unhandled rejection is seen only under Node's default `--unhandled-rejections=throw`. Best effort: the process usually exits before that span is exported. Nestrix adds an `uncaughtExceptionMonitor` listener only and never changes whether the process crashes.
- **Your own spans.** See below.

Server spans carry no `client.address` (the caller's IP is personal data), `server.address` or `server.port`. Client spans record `server.address` and `server.port` of the host they call.

Known limit: on `@nestjs/platform-node`, the `Content-Type` and `Content-Length` response headers are missing from server spans, because that adapter hands them to Node in a way public API cannot read.

## Custom spans

`Span` and `withSpan` are thin wrappers over `@opentelemetry/api`. Code that uses the OpenTelemetry API directly joins the same traces.

<!-- sample: spans -->

```ts
import { Injectable } from "@nestjs/common";
import { Span, withSpan } from "@nestrix/nestjs";

@Injectable()
export class BillingService {
  // The span is named "billing.reconcile". Without an argument it is "BillingService.reconcile".
  @Span("billing.reconcile")
  async reconcile(): Promise<number> {
    return 42;
  }

  async loadRates(): Promise<number[]> {
    return withSpan("load-rates", async (span) => {
      span.setAttribute("rates.source", "cache");
      return [1.1, 1.2];
    });
  }
}
```

`@Span(name?, options?)` wraps a method; the default name is `Class.method`. Other decorators on the same method (`@Get`, `@UseGuards`, `@SetMetadata`) keep working. `withSpan(name, fn, options?)` runs `fn` inside an active span and returns whatever `fn` returns.

- The span ends when the function returns or, if it returns a native promise, when that promise settles. A throw or rejection is recorded, sets error status, and is rethrown unchanged.
- Other thenables and Observables are returned untouched and their span ends when the function returns, so an Observable's span covers none of the stream.
- **The promise a traced method returns must be handled by its caller.** The caller gets a promise derived from the original one. If your method handles its own promise (`p.catch(log); return p`) and the caller ignores the return value, the derived promise's rejection is unhandled, and under Node's default `--unhandled-rejections=throw` the process exits where it would not have without the span. A method that returns a memoised promise returns a new promise object on each call.
- If the tracer itself fails, your function still runs exactly once.

## Logs

Nestrix patches nothing in Nest's logger. To put the trace and span id on your log lines, pass `NestrixLogger` (a `ConsoleLogger`) as the application logger:

<!-- sample: logs -->

```ts
import { NestFactory } from "@nestjs/core";
import { NestrixLogger } from "@nestrix/nestjs";
import { AppModule } from "./app.module";

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: new NestrixLogger(),
  });
  await app.listen(3000);
}
```

While a span is active, text lines end with ` trace_id=… span_id=…`, and in JSON mode (`new NestrixLogger({ json: true })`) each line gets `trace_id` and `span_id` fields. Outside a span the output is `ConsoleLogger`'s. For pino, winston or `nestjs-pino`, `getTraceIds()` returns `{ traceId, spanId }` of the active span, or `undefined`; use it in a `mixin` or format function.

Set `logs: { export: true }` to also send every `NestrixLogger` record over OTLP/HTTP to `/v1/logs` of the configured endpoint (`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is used as given). Records carry Nest's level as OpenTelemetry severity, the logger context as `nestrix.log.context`, and the active span's context. This needs two optional packages; without them Nestrix logs one line with the command and carries on:

```bash
npm install @opentelemetry/sdk-logs @opentelemetry/exporter-logs-otlp-http
```

If your app already registered a `LoggerProvider`, the records go to it and Nestrix registers nothing. Records logged before the packages finish loading at startup are printed but not exported. A failure in correlation or export never changes what the log call prints or throws.

## Privacy

By default Nestrix records no request or response bodies, no query bind parameters and no headers outside an allowlist.

- **Request headers recorded:** `content-type`, `content-length`, `x-request-id`. `user-agent` goes to `user_agent.original`.
- **Response headers recorded:** `content-type`, `content-length`.
- **Always `REDACTED`, even if you list them:** `authorization`, `proxy-authorization`, `cookie`, `set-cookie`.
- **Query values replaced by `REDACTED`** for these keys, case-insensitive: `AWSAccessKeyId`, `Signature`, `sig`, `X-Goog-Signature`, `token`, `access_token`, `refresh_token`, `id_token`, `api_key`, `apikey`, `key`, `password`, `passwd`, `secret`, `client_secret`, `code`, `session`, `sessionid`, `jwt`, `auth`, `authorization`.
- `url.full` on outgoing requests has credentials removed and the same query keys redacted.

`http.requestHeaders`, `http.responseHeaders` and `http.redactQueryKeys` add to these lists.

Key-based redaction cannot clean free text. Exception messages and status messages are stored as they are. Use `redact` for those.

### The `redact` hook

`redact(span)` is called for every span Nestrix exports, after Nestrix's own redaction. It receives an editable copy: `name`, `kind`, `attributes`, `events` (each with editable `attributes`) and `status` (`code`, `message`). `name` and `kind` are read-only: edits to them are discarded, and to hide a span you drop it. Return `false` to drop the span; return anything else to keep it with your edits. Links and their attributes are not exposed; to keep them out, drop the span.

<!-- sample: redact -->

```ts
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix/nestjs";

@Module({
  imports: [
    NestrixModule.forRoot({
      redact: (span) => {
        // Drop a span altogether.
        if (span.name === "GET /internal/debug") return false;

        // Rewrite or delete attributes.
        delete span.attributes["url.query"];

        // Exception messages are stored as they are; rewrite them here.
        for (const event of span.events) {
          if (typeof event.attributes["exception.message"] === "string") {
            event.attributes["exception.message"] = "REDACTED";
          }
        }

        // The status message often repeats the exception message.
        delete span.status.message;
        return undefined;
      },
    }),
  ],
})
export class AppModule {}
```

Rules:

- **It must be synchronous.** A hook that returns a promise drops the span and counts a failure.
- A hook that throws drops the span (fail closed) and counts a failure.
- It runs when a batch is exported, on the batch timer, not in the request. So spans wait **unredacted** in the in-memory queue until their batch is exported. For the dashboard's store it runs shortly after each span ends, also outside the request.
- **It is not applied to what your exporters send when your app owns the SDK.** Then your own exporters send the spans, and Nestrix cannot redact what they send. It still applies to the copy the dashboard stores.

## Shutdown and flushing

Buffered spans are flushed when the Nest application closes: `app.close()` flushes. On `SIGTERM` and `SIGINT` Nest closes the app only if you call `app.enableShutdownHooks()`, so call it if you rely on signals (containers, Kubernetes).

<!-- sample: shutdown -->

```ts
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Needed only so SIGTERM and SIGINT close the app, which flushes buffered spans.
  // app.close() flushes without it.
  app.enableShutdownHooks();
  await app.listen(3000);
}
```

Shutdown is bounded: Nestrix waits at most 5 seconds for the collector. When several Nestrix apps run in one process (an e2e suite), they share one provider; closing the last one shuts it down and removes the OpenTelemetry globals Nestrix registered. A provider your app owns is never flushed or shut down by Nestrix.

## Supported versions

| | |
|---|---|
| Node.js | 26.13 and later |
| NestJS | 12 |
| `@nestjs/platform-express`, `@nestjs/platform-fastify` | from 12.0.0 |
| `@nestjs/platform-node` | from 12.3.2 (12.3.0 and 12.3.1 lose the request context after JSON body parsing) |
| OpenTelemetry JS | SDK 3 only |

Notes:

- Header versioning with two versions of one route does not boot on Fastify with Nest 12.0.0. That is Nest itself, not Nestrix.
- An app with no HTTP adapter (a pure microservice) boots; no HTTP spans are produced.
- Under `@nestjs/testing`, HTTP spans work.

## OpenTelemetry SDK 3 only

Nestrix 0.1 supports OpenTelemetry JS SDK 3 and `@opentelemetry/api` 1.10. SDK 2 hosts must upgrade first.

Its `@opentelemetry/api` peer range is `>=1.10.0 <1.11.0`. A host on `@opentelemetry/api` 1.9.x makes npm stop with `ERESOLVE`:

```text
npm error ERESOLVE unable to resolve dependency tree
npm error peer @opentelemetry/api@">=1.10.0 <1.11.0" from @nestrix/nestjs
```

Upgrade the host's OpenTelemetry packages to SDK 3 and API 1.10. Do not work around it with `--legacy-peer-deps` or `--force`: a second API copy fails silently in both directions, because a copy of another minor version can neither read nor write the global the first one registered, so spans are recorded nowhere. pnpm only prints a warning for the same mismatch; the problem is the same.

## Using it next to other tools

**One hook-based APM per process.** Nest's request hook is a single slot with no getter, so two tools that install it replace each other. Nestrix can only notice one case: a route-triggered hook that another tool set before Nestrix installed its own (or replaced later). It then logs a message at log level, not warning level. A tool that set only the request hook goes unnoticed. Other tools that use only the OpenTelemetry API or diagnostics channels are fine.

**Sentry.** Nestrix and Sentry run side by side, but with Sentry's defaults `@sentry/node` registers no OpenTelemetry provider, so each of the two starts its own trace: a request has two traces, and an outgoing call carries both Nestrix's `traceparent` and Sentry's `sentry-trace` and `baggage` headers on different trace ids. Sentry does not continue an incoming `traceparent`.

If you want one trace (tested in the phase 0 spike, with Express, an ESM host and `@sentry/node` 11.11; not tested in this package): `Sentry.init({ dsn, defaultIntegrations: false, integrations: [Sentry.openTelemetryIntegration()] })`, after Nestrix has registered its provider. The cost is that Sentry loses its default integrations (uncaught exception and unhandled rejection capture, `linkedErrors`, `dedupe`, `contextLines`, `localVariables`, breadcrumbs and others), so you must add back the ones you need. With `openTelemetryIntegration()` and Sentry's default integrations, you still get two traces. Setting `enableOpenTelemetrySetup: true` is not supported: Nestrix's context does not survive Sentry's Express instrumentation there.

Sentry's transport does not mark its requests as untraced, so an error event sent from inside a failing request would become a child span carrying `traceparent`. Add your Sentry ingest host to `ignore.outgoing` (see the `ignore` sample above). Requests Sentry makes outside a request are skipped already, because they have no parent span.

**Other OpenTelemetry instrumentations.** Upstream `@opentelemetry/instrumentation-*` packages (Kafka, AMQP, MongoDB, gRPC) use the same API and join the same traces. You set them up as their documentation says; Nestrix neither manages nor requires their loader flags.

## CommonJS apps

A CommonJS Nest 12 app loads `@nestrix/nestjs` with `require()` (Node's `require(esm)`), and the package has no top-level `await` so that works. Things to know:

- **Jest** needs `node --experimental-vm-modules node_modules/jest/bin/jest.js`, and then loads ESM packages. Without it, Jest fails with `Must use import to load ES Module`. Vitest works unchanged.
- **AWS Lambda** disables `require(esm)` on its Node 20, 22 and 24 runtimes; set `NODE_OPTIONS=--experimental-require-module`.
- **Upstream instrumentations must be constructed after `NestFactory.create`.** In a CommonJS app where Nestrix owns the provider, an `@opentelemetry/instrumentation-*` instance constructed before Nestrix registers takes its tracer too early and produces no spans. Construct it after `NestFactory.create`, or own the tracer provider yourself.

<!-- sample: cjs -->

```ts
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // In a CommonJS app, construct upstream instrumentations (for example
  // new KafkaJsInstrumentation()) here, after NestFactory.create and before listen.
  await app.listen(3000);
}
```

- **Tracers taken at module top level stay no-ops.** In a CommonJS host, `trace.getTracer()` called while a module loads returns a tracer that never records when Nestrix, being ESM, registers the provider later. Call `trace.getTracer()` when you need it, inside the function that creates the span.

## Install size and startup cost

Measured by the repository's `benchmarks/` workspace on an Apple Silicon Mac (darwin-arm64), Node v26.13.0, npm 11.20.0, against `examples/express-esm`. Numbers are medians and will differ on your machine; the commands are in `benchmarks/README.md`.

- **Install size.** The packed `@nestrix/nestjs` tarball is 169 kB (630 kB unpacked in 122 files; `npm pack --dry-run`). The total installed size was measured on 2026-11-11: installed with `npm install --omit=dev` into a fresh directory, a Nest host stack (`@nestjs/common`, `core`, `platform-express`, `reflect-metadata`, `rxjs`) was 21.1 MB, and adding `@nestrix/nestjs` brought it to 40.9 MB: **19.8 MB added**. That includes `@opentelemetry/api`, the peer dependency, which a host without OpenTelemetry has to install anyway (1.9 MB). The largest single item is `@opentelemetry/semantic-conventions` at 9.6 MB; the rest is the OpenTelemetry SDK packages. Sizes are disk blocks (`du -sk`). The dashboard adds `@nestrix/ui`: a 255 kB tarball, about 760 kB unpacked in 11 files (one 655 kB script, one 26.7 kB stylesheet), with no dependencies of its own.
- **Startup.** Time from process spawn to the first `200` on `GET /hello`, 15 fresh processes per configuration: 268.8 ms uninstrumented, 318.8 ms with Nestrix exporting to a local OTLP endpoint (**about 50 ms added**), 320.3 ms with Nestrix and no endpoint (51.5 ms added). Export is asynchronous, so a slow or absent collector does not delay startup. Those runs loaded the OTLP exporter at startup; it is now loaded only when export is on. Measured again that way (20 fresh processes, export off, a later run on the same machine): 246.1 ms uninstrumented, 278.8 ms with Nestrix and the dashboard off (**32.7 ms added**; 295.2 ms, 49.1 ms added, when the exporter is loaded eagerly as before), and 282.9 ms with the dashboard on (36.8 ms added). Idle heap is 1.1 MB lower than when the exporter was loaded at startup (export is off in both configurations).
- **Exporter outage.** Ten minutes at 3,000 requests/s with the OTLP endpoint refusing connections, and again with it accepting requests and never answering: retained heap stayed flat (slope 0.01 and 0.03 MB/min, about 2 MB above a healthy run, which is the queue), and at most two collector connections were open at once. Spans beyond the queue are dropped and counted, not buffered.

## Licence

[Apache-2.0](../../LICENSE)
