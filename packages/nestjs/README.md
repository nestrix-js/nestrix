# @nestrix-js/nestjs

Nest-aware OpenTelemetry tracing for NestJS 12+. Add one module and your app produces a server span per request, outgoing HTTP spans, and your own spans, exported over OTLP to whatever backend you run (Jaeger, Tempo, an OpenTelemetry Collector, a vendor that accepts OTLP).

> **Status: alpha.** Tracing with OTLP export, an embedded dashboard served by your own app, method spans for your own classes, database and cache spans (`pg`, `mysql2`, `ioredis`), BullMQ job traces and microservice spans. Option names are settled for 1.0 (see [Stability](#stability)).

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Dashboard](#dashboard)
- [Options](#options)
- [Environment variables](#environment-variables)
- [What is traced](#what-is-traced)
- [Method spans (level 2)](#method-spans-level-2)
- [Database and cache spans (level 3)](#database-and-cache-spans-level-3)
- [Background jobs (BullMQ)](#background-jobs-bullmq)
- [Microservices](#microservices)
- [Releases and users](#releases-and-users)
- [Metrics](#metrics)
- [Custom spans](#custom-spans)
- [Logs](#logs)
- [Privacy](#privacy)
- [Stability](#stability)
- [Shutdown and flushing](#shutdown-and-flushing)
- [Supported versions](#supported-versions)
- [OpenTelemetry SDK 3 only](#opentelemetry-sdk-3-only)
- [Using it next to other tools](#using-it-next-to-other-tools)
- [CommonJS apps](#commonjs-apps)
- [Install size and startup cost](#install-size-and-startup-cost)

## Install

```bash
pnpm add @nestrix-js/nestjs @opentelemetry/api@~1.10.0
```

`@opentelemetry/api` is a peer dependency, so your app and Nestrix share one copy. Nestrix needs NestJS 12, `reflect-metadata` and `rxjs`, which a Nest app already has. `@nestjs/microservices` and `pg` are optional peers: Nestrix traces microservice messages when the first is installed and `pg` queries when the second is.

The dashboard is a separate, optional package, installed at the same version as `@nestrix-js/nestjs`; see [Dashboard](#dashboard).

```bash
pnpm add @nestrix-js/ui
```

The package is ESM-only. A CommonJS Nest 12 app loads it with `require()`; see [CommonJS apps](#commonjs-apps).

## Quick start

Register the module once, in your root module. It is global: every other module gets it without importing it.

<!-- sample: for-root -->

```ts
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix-js/nestjs";

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
import { NestrixModule } from "@nestrix-js/nestjs";

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

With `forRootAsync`, an `enabled: false` returned from the factory disables Nestrix, but the module's providers are still registered and are inert (they record, export and serve nothing). With `forRoot`, `enabled: false` registers nothing at all.

### A host that already runs an OpenTelemetry SDK

If your app registers its own tracer provider before Nestrix starts (that is, before `NestFactory.create` constructs the module), Nestrix does not create an SDK. Its spans go through your provider and your exporters. In that case `serviceName`, `resourceAttributes`, `OTEL_RESOURCE_ATTRIBUTES`, `sampleRate`, every `export.*` option (except [`export.profiler`](#remote-profiling-from-the-standalone-server), which still checks in with `export.otlp`'s endpoint and headers) and, for what your exporters send, `redact` are ignored (the resource, sampler, exporters and redaction are your SDK's; see [Privacy](#privacy)), and Nestrix logs one line saying so. `ignore`, `http`, `ui` and `store` still apply, and so does `redact` for the copy of each span the dashboard keeps. To see your spans in the dashboard, add `nestrixSpanProcessor()` to your provider ([below](#a-host-that-owns-its-sdk)). Your SDK must be OpenTelemetry JS SDK 3.

**One rule for every signal.** Nestrix exports a signal itself only when it owns the trace provider and trace export is on (an endpoint resolves and `export.otlp` is not `false`). That holds for traces, for metrics and for logs. With a host-owned SDK, Nestrix never starts a `MeterProvider` or a `LoggerProvider` of its own: metrics are recorded through `@opentelemetry/api`, so your `MeterProvider` receives them, and with `logs.export: true` Nestrix logs one line saying it registers no `LoggerProvider`. A logs or metrics endpoint variable alone (`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`) never turns export on.

**Several Nestrix apps in one process** (an e2e suite, for example) share what the first one set up: its `export`, `sampleRate`, resource and `redact` settings, and the outbound `ignore.outgoing` and `http` settings. Later apps' values for those are ignored; Nestrix logs one line when that happens.

Nestrix registers its OpenTelemetry globals during `NestFactory.create`, never at import time or when `forRoot()` runs. If you start your SDK in the body of `main.ts` after importing `AppModule`, start it before `NestFactory.create`.

### Several services or replicas: use the standalone server

The embedded dashboard shows one process. For several services, or several replicas of one service, run the standalone server (`ghcr.io/nestrix-js/nestrix-server`) and set only `OTEL_EXPORTER_OTLP_ENDPOINT` on each service. Nestrix adds a random `service.instance.id` resource attribute per process (override it with `resourceAttributes` or `OTEL_RESOURCE_ATTRIBUTES`) so replicas stay distinguishable. See `examples/standalone` in the repository.

## Dashboard

With `@nestrix-js/ui` installed, `NestrixModule` serves a dashboard from inside your app, at `/_nestrix` by default: recent requests, one request's spans as a waterfall with its [log lines](#logs-next-to-the-trace), error groups, per-route statistics and latency histograms, a [classes view and an app map](#classes-view-and-app-map), dependencies, slow queries, the process [runtime](#runtime-view), and an on-demand CPU [profiler](#profiler); [every view is listed below](#the-views). Apart from starting a profiler capture it is read-only. It polls for new data every two seconds. It works on Express, Fastify and `@nestjs/platform-node`. It shows only what this process has seen since it started; nothing is written to disk and nothing is sent anywhere.

```bash
pnpm add @nestrix-js/ui
```

`@nestrix-js/ui` is an optional peer dependency. Install it at the same version as `@nestrix-js/nestjs`. Without it the dashboard is off and Nestrix logs one line with the install command; the app starts normally. An app with no HTTP adapter (`createMicroservice`, `createApplicationContext`) has no dashboard, and says nothing about it.

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
import { NestrixModule } from "@nestrix-js/nestjs";

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
import { NestrixModule } from "@nestrix-js/nestjs";

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
          authorize: async (request: { headers: IncomingHttpHeaders }) =>
            isOperator(request.headers.authorization),
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
import { nestrixSpanProcessor } from "@nestrix-js/nestjs";

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

Per-route statistics (the Routes view) count **every request**, whatever the sample rate and whether Nestrix or your own SDK does the sampling. They are counted when the response closes, before the sampling decision matters. Requests excluded by `ignore.paths` and requests to the dashboard itself are not counted.

- A statistic is keyed by `METHOD route-template`, for example `GET /users/:id`. A request no route matched is `METHOD (unmatched)`.
- Each key keeps one-minute buckets for the last 60 minutes: request count, error count, and a duration histogram that gives p50, p95 and p99 (30 log-spaced buckets from 1 ms to 60 s, so a percentile is accurate to a bucket, not exact).
- At most 500 keys are tracked; further routes are counted together under `* (other)` (method `*`, route `(other)`).

The request list and the error list come from stored spans, so they **are sampled**. The dashboard says so when `sampleRate` is below 1, and says they may be when your SDK owns the sampler. At `sampleRate: 0.1`, the Routes view shows every request and the list shows about one in ten.

**What is an error.** A span is an error when its status code is `error`. For a server span that means a 5xx response, or a handler exception that maps to 5xx. A thrown `NotFoundException` (404) keeps its exception event in the trace detail but counts as no error in route statistics, the error list or the error filter. The error list holds every stored span with error status, client spans and your own spans included.

### The views

The navigation lists these tabs. Each says whether its numbers are counted before sampling or built from the stored, sampled traces.

| Tab | What it shows | Numbers |
|---|---|---|
| Overview (home) | A health score (0 to 100) with a one-sentence verdict; **Needs attention** and **Getting better**: routes, errors, dependencies (and SLOs on the standalone server) that changed against the previous 15 or 60 minutes, ranked by impact; KPI tiles with their change (throughput, error rate, p95, Apdex, slowest dependency); latency percentiles with release markers; donuts for responses by status and where request time goes; throughput with errors; the Apdex split; the routes that changed most. The thresholds are listed in `docs/backlog/phase-11.md`. | Totals, latency, Apdex and route changes counted before sampling; status mix, time by kind, error and dependency changes sampled; each card says which |
| Requests | Recent traces, newest first, with filters (status, error, route, release, user, type: HTTP, job, scheduled, text) that can be saved by name in the browser. A request timeline chart sits above the list (drag to narrow the range), and each row has a duration bar. | Stored, sampled |
| Trace (click a row) | The span waterfall, a summary of time by span kind and by class, a critical-path toggle (highlights the spans on the critical path), exception events and the [log lines](#logs-next-to-the-trace) written during the request. | Stored, sampled |
| Errors | **Grouped** (the default): errors grouped by type, message and route, with counts, first and last seen and a sparkline; **All**: the flat list of every stored span with error status. | Stored, sampled |
| Routes | Per-route requests, error rate and p50/p95/p99 over 15 or 60 minutes; selecting a route shows its latency histogram, and clicking a bar opens the request list for that latency range. **Compare** sets the last window against the one before it, or two releases, sorted by change. | Counted before sampling, except the release comparison and the histogram links into the list (stored traces) |
| [Classes](#classes-view-and-app-map) | Calls, errors, total and own time per class and method. | Calls, errors, total time counted before sampling; own time sampled |
| [Map](#classes-view-and-app-map) | The app and what it called. | Stored, sampled |
| Queries | The slowest and most frequent database statements across stored traces (statement text without bind values), with the number of traces where a statement ran three or more times (a likely N+1) and links to example traces. | Stored, sampled |
| Dependencies | One row per host, database or Redis the app called: calls, p95, errors and a trend line, with links to example traces. | Stored, sampled |
| [Runtime](#runtime-view) | Event loop delay, heap, RSS and CPU. | Sampled every 10 s from the process |
| [Profiler](#profiler) | An on-demand CPU profile. | Not applicable |

Settings and SLOs exist only in the [standalone server](../../apps/server/README.md); in an embedded dashboard they are not shown, and the Profiler and Runtime tabs are shown only when the app offers them (`meta.profiler.available`, `meta.runtime.available`).

### Runtime view

While the dashboard is on, a timer (every 10 seconds, `unref`'d, stopped at shutdown) records event loop delay (p50, p99 and max, from `perf_hooks.monitorEventLoopDelay`), heap used and total, RSS, and CPU use, and keeps the last 60 minutes. It reads `process` directly, so it needs no MeterProvider and does nothing per request. Nothing is recorded while the dashboard is off, and the standalone server has no runtime view (it cannot see your processes; export the [metrics](#metrics) to a backend instead).

### Classes view and app map

Both depend on other parts of Nestrix and say so when their data is missing.

**Classes.** One row per class (controller, service, repository, processor, and guards and the like when `methods.enhancers` is on), expandable to its methods: calls, errors, average time, total time and **own time** (time not spent in the method's children), over the last 15 or 60 minutes. Calls, errors and total time are counted for every call **before sampling**, like the Routes view, so they are right at any `sampleRate`. Own time is estimated from the sampled spans in the store, and the view says so. The view says so, with the line to add to `main.ts`, until [method spans](#method-spans-level-2) are on; when spans are on but the chosen window holds no method call, it says there is no data in that range rather than that spans are off. A method called outside a trace is counted here although it gets no span.

**Map.** The app in the centre and what it called: databases (by system, host and database name), Redis as a cache, HTTP hosts and message queues, each with calls, errors, p50 and p95 over the last 15 or 60 minutes. It is built from the **sampled** traces in the store, so its counts are proportional to `sampleRate` (the dashboard says so). It shows at most 200 targets; the rest are folded into one `other` node.

### Profiler

The **Profiler** tab takes an on-demand CPU profile of the running process: pick a duration (10 seconds to 2 minutes; the API accepts 1 to 120 seconds, default 30), start, and when it ends you get a flame graph, the top functions by self time and a `.cpuprofile` download that Chrome DevTools and speedscope open. Nothing runs between captures, and nothing is loaded until the first one. One capture runs at a time per process (a second start gets `409`), a start within 10 seconds of the previous capture's end gets `429` with a `Retry-After` header (the dashboard shows "available again in N s"), and the last three are kept in memory until the app restarts. A running capture is discarded when the app closes.

It is offered only where the dashboard is authenticated: `ui: { enabled: true, auth }`, or `'auto'` with the startup token (the default) or `auth`. `'auto'` with `startupToken: false` and no `auth` has no profiler. `ui.profiler: false` removes it everywhere; its routes are then not registered.

What to expect:

- **Starting a capture pauses the app** while V8 records the code it has compiled: about 10 ms per MB of compiled code, 40 to 50 ms in a small Nest app, a few hundred milliseconds in a large one. Requests arriving meanwhile wait. The dashboard shows the pause the last capture measured before you start another. Stopping takes a few milliseconds. During a capture, throughput showed no difference that our benchmark could resolve (under about 5%).
- **JavaScript on the main thread only.** Worker threads are not included, and lines are those of the JavaScript that ran: source maps are not applied.
- **Inlined functions can appear under their caller,** more often after the first capture in a process. This is how V8's profiler works.
- A 30-second capture is about 0.3 MB and a 2-minute one about 1 MB, more in an app with many distinct call stacks.

#### Remote profiling from the standalone server

With `export: { profiler: true, otlp: { endpoint, headers } }` pointing at the [standalone server](../../apps/server/README.md), each instance checks in every 15 seconds (`POST <endpoint>/v1/nestrix/check-in`, with the export headers, so the ingest key) with its `service.name`, `service.instance.id`, `service.version`, host name, pid and Node.js version. An admin picks an instance in the server's Profiler and starts a capture; the instance receives the order at its next check-in, runs it with this same profiler (same limits, one capture per process, the 10-second cool-down) and uploads the `.cpuprofile` itself, gzipped. If it cannot start (another capture is running, the cool-down), it tells the server why. The server never connects to your instances, so this works behind load balancers and NAT. It does not need the embedded dashboard, and it works with your own OpenTelemetry SDK (the instance id is then Nestrix's own, not your resource's). A remote capture also appears in this process's embedded Profiler tab when that is on.

- **Off by default.** Nobody can pause an instance's main thread from outside unless the app turns this on.
- **First check-in a few seconds after the app starts,** then every 15 seconds with some jitter; the timers do not keep the process alive, and `app.close()` stops polling, aborts a request in flight and discards a running capture.
- **An endpoint that is not a Nestrix server** (an OpenTelemetry Collector, Jaeger) answers `404`: one log line, and polling stops until the app restarts. A refused key (`401`, `403`) is retried every 5 minutes; network errors and server errors back off from 15 seconds to 5 minutes. Each change of state is logged once, not each attempt. Redirects are not followed, so the headers never go to another URL.
- **Its requests are not traced.** They run with OpenTelemetry's suppress-tracing flag, as the SDK's own exports do, so they create no spans, carry no `traceparent` and do not appear in the dashboard.

Starting a capture is the dashboard's only request that changes anything, so besides dashboard access it needs a same-origin request from the dashboard page itself: `Sec-Fetch-Site: same-origin`, an `Origin` equal to the server's own origin, a JSON body with `Content-Type: application/json` and a `Content-Length` of at most 1 KB. Browsers send all of this; another site cannot. **Starting a capture needs HTTPS or localhost:** browsers send `Sec-Fetch-Site` only to HTTPS and localhost origins, so over plain HTTP to another host every start is refused with `403` even though the dashboard shows the button (the dashboard then says so). Open the dashboard over HTTPS, or through `localhost` or an SSH tunnel. Behind a reverse proxy, the proxy must pass the original `Host` header (nginx: `proxy_set_header Host $host;`), or the `Origin` check refuses the start. Reading profiles and downloading them follow the same rules as the rest of the dashboard.

### Letting an AI assistant read the dashboard

`@nestrix-js/mcp` is an MCP server that lets Claude Code, Claude Desktop, Cursor and other assistants query this dashboard's API (traces, errors, statistics) and start a profiler capture. It needs `ui: { enabled: true, auth: { token } }`: the `'auto'` startup token is a browser cookie flow a tool cannot use. Against the standalone server it uses a read-only [API token](../../apps/server/README.md#api-tokens). See the [package README](../mcp/README.md).

### When something else answers first (shadowing)

A host route can answer a request under the dashboard path before Nestrix's route sees it: a catch-all route on Express, or `@nestjs/serve-static`'s fallback on Express and platform-node. Nest has no public route table, so Nestrix detects it passively: the first time a `GET` or `HEAD` under the dashboard path is answered, with a status other than 404, without a dashboard handler having run, it logs one line per process.

- With status 401, 403 or 429: `Nestrix dashboard: a request under /_nestrix was answered by host middleware before the dashboard (status 401). ...`. Your auth gate or rate limiter applies to the dashboard too; let requests under that path through.
- Otherwise: `Nestrix dashboard: /_nestrix is shadowed by a host route (a catch-all, or @nestjs/serve-static's fallback): ...`. Fix it in one of these ways. Exclude the dashboard path from that route (for `@nestjs/serve-static`, its `exclude` option, which is what the log line suggests), or set `ui.path` to another path. If the catch-all is a controller route, a global prefix keeps it off the dashboard path, because the dashboard sits outside the prefix. For `@nestjs/serve-static`, the phase 0 spike found it shadows the dashboard when its module initialises first, which followed import order there; importing it after `NestrixModule` may help (not re-tested for this README).

The line appears only after someone opens the dashboard, which is when it matters. Fastify was not affected in the spike.

### Cross-origin pages and CORS

The dashboard never sends CORS allow headers, whatever your CORS setup. Preflight (`OPTIONS`) requests, though, are answered by your CORS layer, not Nestrix, with your allow headers. So a page on another origin could send a request to the dashboard but could not read the answer, and in `'auto'` mode the cookie is `SameSite=Strict`. For the read-only routes this is a known limit and not a hole. The one route that changes state, starting a [profiler](#profiler) capture, has its own protection: it refuses any request that is not same-origin, whatever the preflight answered.

### Memory and the `store` option

The dashboard keeps recent traces in memory, bounded by two limits, and the oldest trace (the one whose first span arrived earliest, with its error items) is evicted first when either is reached. Nothing is written to disk. While the dashboard is off, nothing is stored.

<!-- sample: dashboard-store -->

```ts
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix-js/nestjs";

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

The package exports these types: `NestrixModuleOptions`, `NestrixModuleAsyncOptions`, `NestrixExportOptions`, `NestrixOtlpOptions`, `NestrixQueueOptions`, `NestrixIgnoreOptions`, `NestrixHttpOptions`, `RedactHook`, `RedactableSpan`, `UrlMatcher`, `TraceIds`, `NestrixUiOptions`, `NestrixUiTokenAuth`, `NestrixUiCustomAuth`, `NestrixStoreOptions`, `NestrixMetricsOptions`, `NestrixLogsOptions`, `NestrixMethodsOptions`, `NestrixIntegrationsOptions`, `NestrixEnhancerKind`, `ClassMatcher` and `NestInstrument`. The package also exports `NestrixModule`, `NestrixLogger`, `getTraceIds`, `Span`, `withSpan`, `nestrixSpanProcessor`, `NestrixInstrument`, `composeInstrument`, `nestrixPreRequestHook` and `instrumentClient`. `SpanOptions` is not re-exported: import it from `@opentelemetry/api`.

<!-- sample: all-options -->

```ts
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix-js/nestjs";

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
        paths: ["/health", /^\/metrics/],
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
| `serviceVersion` | the chain in [Releases and users](#releases-and-users) | The `service.version` every trace carries. |
| `user` | none (off) | A synchronous function that returns the user id for a request, recorded as `user.id`. See [Releases and users](#releases-and-users). |
| `methods` | see below | Method spans for your own classes. Needs `NestrixInstrument`. See [`methods`](#methods). |
| `integrations` | see below | Database and cache spans. See [`integrations`](#integrations). |
| `export` | see below | Export settings. |
| `ignore` | none | Requests that get no span. |
| `http` | none | Extra allowlisted headers and redacted query keys. |
| `redact` | none | A synchronous hook that sees every exported span and every span the dashboard stores. |
| `ui` | `'auto'` | The embedded dashboard: `false`, `'auto'` or an object. See [Dashboard](#dashboard) and [`ui`](#ui). |
| `store` | see below | Limits of the dashboard's in-memory store. See [`store`](#store). |
| `logs` | `{ export: false }` | Log export over OTLP. See [Logs](#logs). |
| `logs.export` | `false` | Send `NestrixLogger` records over OTLP to `/v1/logs`, under the same rule as metrics (see [One rule for every signal](#a-host-that-already-runs-an-opentelemetry-sdk)). Needs `@opentelemetry/sdk-logs` and `@opentelemetry/exporter-logs-otlp-http`. See [Logs](#logs). |
| `metrics` | on | Request-duration and runtime metrics. See [Metrics](#metrics) and [`metrics`](#metrics-option). |

### `methods`

Method spans need `instrument: NestrixInstrument` in `main.ts`; see [Method spans](#method-spans-level-2). Without it these options do nothing.

| Option | Default | |
|---|---|---|
| `methods` | an object, or `false` | Which methods get spans. `false` turns method spans off. |
| `methods.include` | none | Classes traced in addition to your own: a class, an exact name or a `RegExp`. |
| `methods.exclude` | none | Classes never traced, in the same forms. Wins over `include`. |
| `methods.enhancers` | `false` | `true` for guard, pipe, interceptor and filter spans, or an array such as `['guard']` for some. |

### `integrations`

| Option | Default | |
|---|---|---|
| `integrations` | an object | Database and cache spans. See [Database and cache spans](#database-and-cache-spans-level-3). |
| `integrations.pg` | `true` | On when `pg` is installed. `false` turns it off. |
| `integrations.mysql2` | `false` | Opt-in. Once on, mysql2 swallows an unhandled query error instead of crashing. |
| `integrations.ioredis` | `false` | Opt-in, with the same kind of swallowed error. `true`, or `{ rootSpans: true }` to also keep commands that run outside any trace (dropped by default). |

An invalid `methods` or `integrations` value throws, like the other options.

### `export.otlp`

| Option | Default | |
|---|---|---|
| `export.otlp` | an object, or `false` | `false` turns off all OTLP export (traces, logs and metrics) even when the environment sets an endpoint. The same `endpoint` and `headers` feed `/v1/traces`, `/v1/logs` and `/v1/metrics`. |
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

### `export.profiler`

| Option | Default | |
|---|---|---|
| `export.profiler` | `false` | Lets the [standalone server](../../apps/server/README.md) take CPU profiles of this instance ([remote profiling](#remote-profiling-from-the-standalone-server)). Needs a base endpoint: `export.otlp.endpoint` or `OTEL_EXPORTER_OTLP_ENDPOINT` (a full `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` alone is not enough), and `export.otlp` not `false`; otherwise one line says it is off. Sends the same headers as the trace export. A non-boolean throws. |

### `ignore`

| Option | Default | |
|---|---|---|
| `ignore.paths` | none | Incoming requests that get no server span. Matched against the request path without the query string. A string must equal the path exactly: `"/health"` does not match `"/health/live"`. |
| `ignore.outgoing` | none | Outgoing requests that get no client span and no `traceparent` header. Matched against the recorded `url.full` (credentials removed, listed query values already `REDACTED`). A string is a **prefix**, for example `"https://o123.ingest.sentry.io/"`. |

A matcher is a string, a `RegExp` or a function. In `ignore.paths` a `RegExp` is applied with `search`, so the `g` flag and `lastIndex` do not matter. In `ignore.outgoing` its `lastIndex` is reset to 0 and `test` is called. A function receives the path or URL and must return `true` to match. A matcher that throws counts as a match, and the failure is counted. Counts are internal for now: there is no public accessor, and drops because the queue is full are counted but not logged.

<!-- sample: ignore -->

```ts
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix-js/nestjs";

@Module({
  imports: [
    NestrixModule.forRoot({
      ignore: {
        // A string matches the request path exactly: "/health" does not match "/health/live".
        paths: ["/health", /^\/health\//, (path) => path.endsWith(".map")],
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
| `ui.profiler` | `true` | The on-demand CPU [profiler](#profiler). Offered only where the dashboard is authenticated (`enabled: true`, or `'auto'` with the startup token or `auth`). `false` removes it and its routes. |
| `ui.logs` | `true` | Keep `NestrixLogger` lines next to their trace in the dashboard store ([Logs next to the trace](#logs-next-to-the-trace)). `false` keeps none; the logger still prints and the correlation ids are unchanged. |

An invalid `ui` value (wrong type, bad path, short token, both `token` and `authorize`) turns the dashboard off and logs an error; it does not throw.

### `store`

| Option | Default | |
|---|---|---|
| `store.maxTraces` | `5000` | Traces the dashboard keeps. Positive integer. |
| `store.maxBytes` | `33554432` (32 MiB) | Estimated bytes of stored spans. Positive integer. |

Ignored while the dashboard is off. See [Memory and the `store` option](#memory-and-the-store-option).

### `metrics` option

| Option | Default | |
|---|---|---|
| `metrics` | an object | `false` records no metrics at all. See [Metrics](#metrics). |
| `metrics.runtime` | `true` | Event-loop delay, V8 heap, RSS and CPU time. `false` keeps the request histogram only. |
| `metrics.export` | `true` | `false` turns Nestrix's own OTLP metric export off and keeps recording through the API, so a `MeterProvider` your app registers still receives the metrics. |

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
| `OTEL_EXPORTER_OTLP_LOGS_HEADERS` | Same format, for logs; wins over the generic variable key by key. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Full metrics URL, used as given, when `export.otlp.endpoint` is not set. Does not switch export on by itself. |
| `OTEL_EXPORTER_OTLP_METRICS_HEADERS` | Same as the headers variable, for metrics; wins over the generic one key by key. |
| `OTEL_METRIC_EXPORT_INTERVAL` | Milliseconds between metric exports. Default `60000`; a value that is not a positive integer is ignored. |

An option always wins over the variable of the same meaning. Nestrix itself reads no other `OTEL_*` variables. In particular `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`, `OTEL_SDK_DISABLED` and `OTEL_EXPORTER_OTLP_PROTOCOL` are not read: use `sampleRate` and `enabled` (or `NESTRIX_ENABLED`), and note that export is OTLP/HTTP with protobuf only. The OTLP exporter Nestrix uses reads a few on its own, though: the OTLP exporter it uses reads some on its own:

- `OTEL_EXPORTER_OTLP_COMPRESSION` and `OTEL_EXPORTER_OTLP_TRACES_COMPRESSION` take effect (read by `@opentelemetry/otlp-exporter-base` 0.301.1; found in its source, not run through Nestrix).
- `OTEL_EXPORTER_OTLP_TIMEOUT` has no effect: Nestrix always passes `timeoutMillis` (default 10000).
- `OTEL_EXPORTER_OTLP_CERTIFICATE`, `…_CLIENT_CERTIFICATE` and `…_CLIENT_KEY` (and their `_TRACES_` forms) have no effect through Nestrix: the exporter uses them only to build its default HTTP agent, and Nestrix supplies its own agent factory, which wins in the exporter's configuration merge. Use a collector or proxy in front for mutual TLS.

When your app owns the SDK, the export variables are your SDK's business, not Nestrix's.

## What is traced

- **Incoming HTTP.** One server span per request, named `METHOD /route/template` (or `METHOD` when no route matched, as for a 404), with the OpenTelemetry HTTP attributes, `code.function.name` (`Controller.handler`), the status, and the first exception a handler or pipe threw as an exception event. An incoming `traceparent` is continued. If the client goes away before the response finishes, the span carries `nestrix.http.aborted = true`.
- **Outgoing HTTP.** `node:http` and `fetch` (undici) calls get a client span named `METHOD`, and a `traceparent` header unless the request already has one. A request made with no active parent span gets no span and no header, so background traffic (a health poller, an error reporter's transport outside a request) is not traced. If the response body is never read, the span ends at the response head and carries `nestrix.http.body = "not consumed"`: for `node:http`, on the next turn of the event loop if nothing is reading; for `fetch` and undici, after 30 seconds. The 30 seconds restart with each body chunk. A `node:http` caller that starts reading on a later tick also gets a head-only span. A body the caller cancels after the response head is marked `"cancelled"` and is not an error. A request whose method is not in the HTTP conventions' list gets the span name `HTTP` and `http.request.method = "_OTHER"`; this applies to server spans too.
- **Exceptions.** A handler's or pipe's exception is recorded on the server span. An exception thrown by a guard is not: guards run before Nestrix's interceptor, so a guard rejection keeps its route name and records no exception event.
- **Process errors.** An uncaught exception becomes an exception event on the active request span, or a short span of its own. An unhandled rejection is seen only under Node's default `--unhandled-rejections=throw`. Best effort: the process usually exits before that span is exported. Nestrix adds an `uncaughtExceptionMonitor` listener only and never changes whether the process crashes.
- **Your own classes' methods.** With one line in `main.ts`; see [Method spans](#method-spans-level-2).
- **Database and cache calls.** `pg` by default, `mysql2` and `ioredis` on request; see [Database and cache spans](#database-and-cache-spans-level-3).
- **Background jobs.** See [BullMQ](#background-jobs-bullmq); scheduled methods are in [Method spans](#method-spans-level-2).
- **Microservice messages.** See [Microservices](#microservices).
- **Your own spans.** See [Custom spans](#custom-spans).

Server spans carry no `client.address` (the caller's IP is personal data), `server.address` or `server.port`. Client spans record `server.address` and `server.port` of the host they call.

Known limit: on `@nestjs/platform-node`, the `Content-Type` and `Content-Length` response headers are missing from server spans, because that adapter hands them to Node in a way public API cannot read.

## Method spans (level 2)

HTTP spans need no setup. To also get a span for each method your own classes run, pass Nestrix's `instrument` object to `NestFactory.create`. This is Nest's own `instrument` option, which hands every instance to a decorator as it is created.

<!-- sample: main-instrument -->

```ts
import { NestFactory } from "@nestjs/core";
import { NestrixInstrument } from "@nestrix-js/nestjs";
import { AppModule } from "./app.module";

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Level 2: lets Nestrix wrap your own classes' methods as they are created.
    instrument: NestrixInstrument,
  });
  await app.listen(3000);
}
```

Nest accepts one `instrument` object. If another tool needs it too, combine them with `composeInstrument`; each decorator is guarded, so one that throws leaves the instance as it was and does not stop the others:

<!-- sample: compose-instrument -->

```ts
import { NestFactory } from "@nestjs/core";
import { composeInstrument, NestrixInstrument } from "@nestrix-js/nestjs";
import { AppModule } from "./app.module";

// Another tool's `instrument` object, with the same `instanceDecorator` shape.
declare const otherTool: { instanceDecorator: (instance: unknown) => unknown };

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    instrument: composeInstrument(NestrixInstrument, otherTool),
  });
  await app.listen(3000);
}
```

A method span is named `Class.method` and carries `code.function.name`, `nestrix.class`, `nestrix.method` and `nestrix.component` (`controller`, `service`, `repository`, `processor`, `guard`, `pipe`, `interceptor`, `filter` or `provider`; a class is a `service` or `repository` when its name ends in `Service` or `Repository`). A throw is recorded on the span and rethrown unchanged. Spans nest under the request's server span: controller, then service, then repository, then the database span.

**What is traced by default: your own classes.** Nestrix traces the controllers, services, repositories and queue processors that **your application's modules list**. It finds them from the static `@Module()` metadata: starting at the root module, it follows `imports` entries that are module classes and takes the classes listed in `controllers` and `providers`. So:

- Providers that come from a library are not traced. Libraries register theirs through dynamic modules (`ConfigModule.forRoot()`, `TypeOrmModule.forFeature()`, `BullModule.registerQueue()`), and tracing them would put `@nestjs/schedule`'s and `@nestjs/config`'s internals in every trace.
- A module that defines `forRoot`, `forRootAsync`, `forFeature`, `forFeatureAsync`, `register` or `registerAsync` is not entered, even when you import it by class. So a service provided by **your own** dynamic module is not traced until you `include` it. Library modules that list providers in plain `@Module()` metadata (`HttpModule`, `TerminusModule`) are left out for the same reason.
- Guards, pipes, interceptors and filters get no span by default; set `methods.enhancers`. A guard's exception is then recorded too.

<!-- sample: methods-options -->

```ts
import { Injectable, Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix-js/nestjs";

// Provided by your own dynamic module, so not traced unless included.
@Injectable()
export class PaymentsGateway {}

@Module({
  imports: [
    NestrixModule.forRoot({
      methods: {
        // A class, an exact name or a RegExp. Added to the app's own classes.
        include: [PaymentsGateway, /Client$/],
        // Never traced. Wins over `include`.
        exclude: ["HealthService"],
        // Guards, pipes, interceptors and filters. Default false; true is all four.
        enhancers: ["guard"],
      },
    }),
  ],
})
export class AppModule {}
```

`exclude` wins over `include`, which wins over `enhancers`, which wins over the own-class default. `methods: false` turns method spans off. Nestrix's own providers are never traced.

**Only inside a trace.** A method called with no active span, such as startup work in `onModuleInit` or a WebSocket gateway handler, gets no span: a root span there would only fill the trace list. It is still counted in the [classes view](#classes-view-and-app-map). Two kinds of method are the exception, because they start work of their own:

- **Scheduled methods** (`@Cron`, `@Interval` and `@Timeout` from `@nestjs/schedule`) start a new root trace on every run, with `nestrix.entry = "scheduled"`, linked to whatever span was active when the timer fired. They never hang under one old trace.
- **A BullMQ `@Processor`'s `process`** is a child of the job's consumer span when BullMQ's telemetry is on, and a new root with `nestrix.entry = "job"` otherwise. See [BullMQ](#background-jobs-bullmq).

Things to know:

- The wrappers are installed as each instance is created, before Nest reads your routes, so a method-level `@UseGuards` keeps applying and a guarded route still returns 403. There is no `Proxy`: `this` stays the real instance (`#private` members work) and the class's prototype is untouched.
- **The promise a traced method returns must be handled by its caller.** The caller gets a promise derived from the original. A method that handles its own promise (`p.catch(log); return p`) while its caller ignores the return value turns a rejection into an unhandled one, and under Node's default `--unhandled-rejections=throw` the process exits where it would not have without the span. A method that returns a memoised promise returns a new promise object on each call. Observables and other thenables are returned untouched, and their span ends when the method returns.
- **`@nestjs/testing` is not supported.** Nest gives the testing module no `instrument` option, so under `Test.createTestingModule` there are no method spans (HTTP spans still work), and the classes view stays empty.

## Database and cache spans (level 3)

A database span is a child of the method or request that ran the query, so a slow query appears under the service that issued it. Spans use the OpenTelemetry database conventions: `db.system.name` (`postgresql`, `mysql` or `redis`), `db.operation.name`, `db.query.text`, `db.namespace`, `server.address` and `server.port`.

<!-- sample: integrations -->

```ts
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix-js/nestjs";

@Module({
  imports: [
    NestrixModule.forRoot({
      integrations: {
        pg: true, // the default; false turns it off
        mysql2: true, // opt-in: mysql2 then swallows unhandled query errors
        ioredis: { rootSpans: false }, // opt-in; true keeps commands outside any trace
      },
    }),
  ],
})
export class AppModule {}
```

| Library | Default | How |
|---|---|---|
| `pg` | on, when `pg` is installed | Wraps `Client.prototype.query` and `Pool.prototype.query`. Covers raw `pg`, `pg-cursor`, `pg-query-stream` and ORMs built on `pg` (TypeORM, Drizzle, Prisma on `@prisma/adapter-pg`, MikroORM). |
| `mysql2` | **off** | Subscribes to mysql2's tracing channels (mysql2 3.20 or later). |
| `ioredis` | **off** | Subscribes to ioredis's channels (ioredis 5.11 or later). |

**`pg` and nested copies.** An ORM may bring its own copy of `pg` (MikroORM pins one exactly). Nestrix wraps copies that are already loaded when it starts, and again at `onApplicationBootstrap`. A copy loaded at import time, or in a provider factory during startup, is traced. **A copy first loaded during a request is not**, and neither is any copy loaded after the last scan: its queries get no span.

**Why `mysql2` and `ioredis` are opt-in.** Both libraries change behaviour once anything subscribes to their tracing channels, and no way of subscribing avoids it. With `mysql2`, an event-emitter query that fails with no `'error'` listener raises `uncaughtException` and closes the connection when nothing is subscribed, and is **silently swallowed** when Nestrix subscribes. With `ioredis`, a failing command that nobody awaits raises `unhandledRejection` normally, and nothing when Nestrix subscribes. In a default app that is a crash turned into silence. Enable them only if you accept that: a bug that would have crashed in development will not.

**`ioredis` and root commands.** A command that runs with no active span (the connection handshake, or commands queued before the connection was ready) is dropped by default, because it belongs to no request. `integrations.ioredis: { rootSpans: true }` keeps them as root spans.

**What a span records.** The statement with literals replaced by `?` (strings, numbers, hex and boolean literals; `IN (...)` lists collapsed; comments dropped; cut to 2,048 characters). If Nestrix cannot parse a statement safely, it records a fixed placeholder, never the raw text. **Bind parameters are never recorded**, and there is no option to. For Redis the span records the command and its first argument (`GET user:1`), never values. A database span **covers the query only**: time spent waiting for a pooled connection is not in it, so a saturated pool shows as a gap before the span, not as a slow query.

If the library is not installed the integration reports itself disabled and does nothing. An integration that is off subscribes to nothing.

## Background jobs (BullMQ)

BullMQ has its own OpenTelemetry support. Give it a `BullMQOtel` from `bullmq-otel` (a separate package; Nestrix does not depend on it) and it records its own spans and puts the trace context in each job:

<!-- sample: bullmq -->

```ts
import { BullModule, Processor, WorkerHost } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { BullMQOtel } from "bullmq-otel";
import { NestrixModule } from "@nestrix-js/nestjs";

@Processor("emails")
export class EmailProcessor extends WorkerHost {
  // With `NestrixInstrument` in main.ts, `process` gets a span named "EmailProcessor.process".
  async process(): Promise<void> {}
}

@Module({
  imports: [
    BullModule.forRoot({
      connection: { host: "localhost", port: 6379 },
      // The one line: BullMQ records its own spans and carries the trace context in each job.
      telemetry: new BullMQOtel({ tracerName: "my-app" }),
    }),
    BullModule.registerQueue({ name: "emails" }),
    NestrixModule.forRoot(),
  ],
  providers: [EmailProcessor],
})
export class AppModule {}
```

`telemetry` set on `BullModule.forRoot()` reaches the queues and the workers `@nestjs/bullmq` creates. `BullMQOtel` takes an options object, `{ tracerName }`. With `NestrixInstrument` ([level 2](#method-spans-level-2)), a `@Processor` class's `process` method also gets a method span with `nestrix.entry = "job"`. Nestrix adds no code of its own for jobs: BullMQ makes the spans and Nestrix shows them.

The trace shape, checked against BullMQ 6.7 and `bullmq-otel` 2.0 with real Postgres and Redis (`test/e2e-phase3/`): a job added during a request stays in that request's trace.

```text
GET /orders                      server
  OrderController.place
    OrderService.place
      add emails.welcome         producer (BullMQ)
        process emails           consumer (BullMQ, runs later in the worker)
          EmailProcessor.process method span, nestrix.entry = "job"
          complete emails        (BullMQ)
```

The consumer span is a **child** of the producer span in the same trace, with no span link, so a request and the jobs it queued show as one trace, however much later the worker ran them. A job added outside a request (no active span) starts a trace of its own. Without `telemetry`, the processor's method span (if `NestrixInstrument` is on) is a root span: nothing connects it to the request that queued the job. In the dashboard's request list, the `jobs` type filter shows traces that a job started.

## Microservices

With `@nestjs/microservices` installed, Nestrix traces messages in both directions and connects them to the request that sent them. The trace context travels in the message's metadata: inside the packet for TCP and Redis, in headers for NATS, RabbitMQ, Kafka and MQTT 5.

- **Handler spans.** A `@MessagePattern` handler gets a `SERVER` span and an `@EventPattern` handler a `CONSUMER` span, named `<transport> <pattern>` (`tcp sum`, `kafka orders.created`), with `messaging.system`, `messaging.destination.name` and `messaging.operation.type = "process"`. The span is a child of the caller's span when the message carries trace context, and ends when the handler's stream completes or errors. A trace that a message handler starts shows in the request list as type `other`, not `http`.
- **Client spans.** `send` gets a `CLIENT` span per subscription and `emit` a `PRODUCER` span. Nestrix adds the active trace context to each outgoing packet's metadata. With no active span (a message sent from a bare timer, say) there is no span and no metadata.
- **No setup** for clients registered through `ClientsModule` (found at startup; a call made before that is not traced), for microservice-only apps (`NestFactory.createMicroservice`), or for a hybrid app whose microservice is connected with `inheritAppConfig: true`.

**Hybrid apps.** By default `app.connectMicroservice(options)` gives the microservice its own configuration, which does not include the global interceptor that `NestrixModule` registers, so its handlers get no span. One line fixes that, and it also covers messages a guard rejects:

<!-- sample: microservices-hybrid -->

```ts
import { NestFactory } from "@nestjs/core";
import { Transport } from "@nestjs/microservices";
import { nestrixPreRequestHook } from "@nestrix-js/nestjs";
import { AppModule } from "./app.module";

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app
    .connectMicroservice(
      { transport: Transport.TCP, options: { port: 4000 } },
      // Defers listener registration so the hook below is set in time.
      { deferInitialization: true },
    )
    .registerPreRequestHook(nestrixPreRequestHook);
  await app.startAllMicroservices();
  await app.listen(3000);
}
```

Without it, a hybrid app's handlers get no Nestrix span, and a span you start inside one is a new root although the trace context arrived. A message that both the hook and the interceptor see is traced once.

**Clients outside dependency injection.** A client built with `ClientProxyFactory.create()` or `new ClientTCP()` is not found automatically. Wrap it; `instrumentClient` returns the same client:

<!-- sample: microservices-client -->

```ts
import { ClientProxyFactory, Transport } from "@nestjs/microservices";
import { instrumentClient } from "@nestrix-js/nestjs";

// A client made outside dependency injection. `ClientsModule` clients need nothing.
export const client = instrumentClient(
  ClientProxyFactory.create({
    transport: Transport.TCP,
    options: { host: "localhost", port: 4000 },
  }),
);
```

**Another tool's dispatch hook.** A client has one dispatch-hook slot, and Nest offers no public way to read it. If a hook was already set on a client when Nestrix instruments it, Nestrix keeps yours, injects no trace context for that client and logs one line; that client still gets spans. If something sets a hook after Nestrix, it replaces Nestrix's, and Nestrix logs once when it notices a call completing without its hook.

**Transports.** Tested end to end with real brokers, as one connected trace across an HTTP request, a `send` and an `emit`: TCP, Redis, NATS, RabbitMQ, Kafka and MQTT 5.

- **MQTT 3** has no header channel, so handler spans there start new traces.
- **gRPC** was not tested. Its clients have no `send` or `emit`, so they get no client span, and its server handlers receive gRPC metadata that Nestrix does not read, so handler spans are roots.
- A custom transport is traced but named `rpc <pattern>` with no `messaging.system`. Kafka's `emitBatch` injects context but gets no span.
- `emit` is dispatched when it is called, whether or not anyone subscribes, so its span starts at the call.

## Releases and users

**Release.** Every trace carries `service.version`, so the request list can be filtered by release and a deploy that made things worse shows up. Nestrix takes the first of these that is set: the `serviceVersion` option, `service.version` in `resourceAttributes`, `service.version` in `OTEL_RESOURCE_ATTRIBUTES`, the `GIT_SHA` environment variable, then `npm_package_version` (set by `npm run` and `pnpm run`, not by `node dist/main.js`). When your app owns the SDK, its resource wins and these are ignored.

**User.** Which user made a request is personal data, so it is **off** unless you give `user`: a function that reads the request and returns a string or number. It runs once per sampled request, as the response closes, with the object your guards get from `context.switchToHttp().getRequest()` (Express's `req`, Fastify's `FastifyRequest`, platform-node's `IncomingMessage`). Guards have run by then, so a `request.user` set by Passport's `AuthGuard` or your own guard is visible. It is `undefined` on a route with no guard, and when a guard rejected the request. The result is recorded as `user.id`, cut to 256 characters, and goes through `redact`. The function must be synchronous; a throw, a promise or any other result records nothing and never affects the request.

<!-- sample: release-user -->

```ts
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix-js/nestjs";

@Module({
  imports: [
    NestrixModule.forRoot({
      // The release shown in the dashboard. Without it Nestrix reads GIT_SHA, then npm_package_version.
      serviceVersion: process.env.GIT_SHA,
      // Off unless set. `request` is what your guards get; a guard sets `request.user`.
      user: (request: { user?: { id?: string } }) => request.user?.id,
    }),
  ],
})
export class AppModule {}
```

The dashboard's request list shows release and user columns when any stored trace has them, and filters by release, user and trace type (HTTP, jobs, scheduled).

## Metrics

Nestrix records metrics through `@opentelemetry/api`'s metrics API. If your app registers a `MeterProvider` (the OpenTelemetry Node SDK does), it receives them as they are, with your readers and exporters.

- **`http.server.request.duration`**, a histogram in seconds with the bucket boundaries the HTTP semantic conventions advise, for every request, sampled or not: it is right at any `sampleRate` and under your own sampler. Attributes: `http.request.method`, `url.scheme` (`http` or `https`), `http.route` (when a handler matched), `http.response.status_code` (when a response was sent) and `error.type` (on the same rule as the span's error status). Requests under `ignore.paths` and the dashboard path are not counted.
- **Runtime metrics**, read only when a reader collects: `nodejs.eventloop.delay.p50`, `.p99` and `.max` (seconds, covering the time since the last collection by any reader, so with two readers each sees only the window the other left), `v8js.memory.heap.used` and `v8js.memory.heap.space.size` (bytes, per `v8js.heap.space.name`), `process.memory.usage` (RSS, bytes) and `process.cpu.time` (seconds, per `cpu.mode`). Names follow `@opentelemetry/semantic-conventions` 1.45.0, where they are still experimental and may be renamed. `v8js.memory.heap.limit` is deprecated there and not reported.

With no `MeterProvider` registered and no export, nothing is recorded and the event-loop monitor does not run.

**Export.** When Nestrix owns the tracer provider and exports traces, it also exports metrics over OTLP/HTTP to `/v1/metrics` of the same endpoint (or `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`), every 60 seconds (`OTEL_METRIC_EXPORT_INTERVAL`), with the same headers and timeout. This needs two optional packages:

```bash
pnpm add @opentelemetry/sdk-metrics@^3.1.1 @opentelemetry/exporter-metrics-otlp-http@^0.301.1
```

Without them Nestrix logs one line with that command and carries on; metrics stay API-only. Nestrix registers its own `MeterProvider` only when none is registered, never replaces yours, and flushes it on `app.close()` within the same 5-second bound as spans.

<!-- sample: metrics -->

```ts
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix-js/nestjs";

@Module({
  imports: [
    NestrixModule.forRoot({
      export: { otlp: { endpoint: "http://otel-collector:4318" } },
      // The default: the request histogram and runtime metrics. `false` records none.
      metrics: { runtime: true },
    }),
  ],
})
export class AppModule {}
```

## Custom spans

`Span` and `withSpan` are thin wrappers over `@opentelemetry/api`. Code that uses the OpenTelemetry API directly joins the same traces.

<!-- sample: spans -->

```ts
import { Injectable } from "@nestjs/common";
import { Span, withSpan } from "@nestrix-js/nestjs";

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
import { NestrixLogger } from "@nestrix-js/nestjs";
import { AppModule } from "./app.module";

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: new NestrixLogger(),
  });
  await app.listen(3000);
}
```

While a span is active, text lines end with ` trace_id=… span_id=…`, and in JSON mode (`new NestrixLogger({ json: true })`) each line gets `trace_id` and `span_id` fields. Outside a span the output is `ConsoleLogger`'s. For pino, winston or `nestjs-pino`, `getTraceIds()` returns `{ traceId, spanId }` of the active span, or `undefined`; use it in a `mixin` or format function.

Set `logs: { export: true }` to also send every `NestrixLogger` record over OTLP/HTTP to `/v1/logs` of the configured endpoint (`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is used as given once trace export is on; it does not turn export on by itself). Like metrics, this runs only when Nestrix owns the trace provider; see [One rule for every signal](#a-host-that-already-runs-an-opentelemetry-sdk). Records carry Nest's level as OpenTelemetry severity, the logger context as `nestrix.log.context`, and the active span's context. This needs two optional packages; without them Nestrix logs one line with the command and carries on:

```bash
npm install @opentelemetry/sdk-logs @opentelemetry/exporter-logs-otlp-http
```

If your app already registered a `LoggerProvider`, the records go to it and Nestrix registers nothing. With a host-owned tracer provider Nestrix registers no `LoggerProvider` at all and logs one line saying so. Records logged before the packages finish loading at startup are printed but not exported. A failure in correlation or export never changes what the log call prints or throws.

### Logs next to the trace

With the dashboard on, a `NestrixLogger` line written while a recording span is active is also kept in the dashboard's store with its trace, and the trace view lists it beside the waterfall (click a line to select its span). This needs no package; `ui: { logs: false }` stops keeping lines (the logger still prints and the correlation ids are unchanged). Lines whose trace has no span yet are held apart, at most a tenth of `store.maxTraces` of them, oldest dropped first, so a burst of logs cannot push out real traces. What is kept: time, level, logger context and the message after the logger's own `redact` option, cut to 8,192 characters (no stack traces). At most 200 lines per trace; they count toward `store.maxBytes` and leave with their trace. Lines outside a span, or under a span that is not sampled, are not kept. The dashboard is not a log viewer: there is no search across lines. The standalone server does the same for log records sent to its `/v1/logs` (point `logs.export` at it). Log messages are free text, so the advice in [What the dashboard shows](#what-the-dashboard-shows) applies: use the logger's `redact` option for structured values you do not want shown, and do not log secrets.

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

`redact(span)` is called for every span Nestrix exports, after Nestrix's own redaction. It receives an editable copy: `name`, `kind`, `attributes`, `events` (each with editable `attributes`) and `status` (`code`, `message`). `name` and `kind` are read-only: edits to them are discarded, and to hide a span you drop it. Return `false` to drop the span; return nothing (or anything else) to keep it with your edits. Links and their attributes are not exposed; to keep them out, drop the span.

<!-- sample: redact -->

```ts
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix-js/nestjs";

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
- An app with no HTTP adapter (a pure microservice) boots; it has no HTTP spans and no dashboard, and its message handlers are traced ([Microservices](#microservices)).
- Under `@nestjs/testing`, HTTP spans work; method spans do not ([Method spans](#method-spans-level-2)).
- The full matrix, with the test or CI job behind each row, is in [docs/compatibility.md](https://github.com/nestrix-js/nestrix/blob/main/docs/compatibility.md); coming from a 0.x build, read [docs/upgrading.md](https://github.com/nestrix-js/nestrix/blob/main/docs/upgrading.md).
- Library spans were tested against `pg` 8.23, `mysql2` 3.24, `ioredis` 6.0 and BullMQ 6.7 with `bullmq-otel` 2.0, and microservices against `@nestjs/microservices` 12.4.

## Stability

From 1.0, semantic versioning covers the exports of `@nestrix-js/nestjs`, the option names and their defaults, and the environment variables documented above. It does not cover the dashboard's query API (`/_nestrix/api/v1`) or the `@nestrix-js/protocol` types: they are internal to the bundled UI, which ships at the same version as the package. The names of the runtime metrics and the default set of traced classes may change in a minor release.

## OpenTelemetry SDK 3 only

Nestrix 0.1 supports OpenTelemetry JS SDK 3 and `@opentelemetry/api` 1.10. SDK 2 hosts must upgrade first.

Its `@opentelemetry/api` peer range is `>=1.10.0 <1.11.0`. A host on `@opentelemetry/api` 1.9.x makes npm stop with `ERESOLVE`:

```text
npm error ERESOLVE unable to resolve dependency tree
npm error peer @opentelemetry/api@">=1.10.0 <1.11.0" from @nestrix-js/nestjs
```

Upgrade the host's OpenTelemetry packages to SDK 3 and API 1.10. Do not work around it with `--legacy-peer-deps` or `--force`: a second API copy fails silently in both directions, because a copy of another minor version can neither read nor write the global the first one registered, so spans are recorded nowhere. pnpm only prints a warning for the same mismatch; the problem is the same.

## Using it next to other tools

**One hook-based APM per process.** Nest's request hook is a single slot with no getter, so two tools that install it replace each other. Nestrix can only notice one case: a route-triggered hook that another tool set before Nestrix installed its own (or replaced later). It then logs a message at log level, not warning level. A tool that set only the request hook goes unnoticed. Other tools that use only the OpenTelemetry API or diagnostics channels are fine.

**Sentry.** Nestrix and Sentry run side by side, but with Sentry's defaults `@sentry/node` registers no OpenTelemetry provider, so each of the two starts its own trace: a request has two traces, and an outgoing call carries both Nestrix's `traceparent` and Sentry's `sentry-trace` and `baggage` headers on different trace ids. Sentry does not continue an incoming `traceparent`.

If you want one trace (tested in the phase 0 spike, with Express, an ESM host and `@sentry/node` 11.11; not tested in this package): `Sentry.init({ dsn, defaultIntegrations: false, integrations: [Sentry.openTelemetryIntegration()] })`, after Nestrix has registered its provider. The cost is that Sentry loses its default integrations (uncaught exception and unhandled rejection capture, `linkedErrors`, `dedupe`, `contextLines`, `localVariables`, breadcrumbs and others), so you must add back the ones you need. With `openTelemetryIntegration()` and Sentry's default integrations, you still get two traces. Setting `enableOpenTelemetrySetup: true` is not supported: Nestrix's context does not survive Sentry's Express instrumentation there.

Sentry's transport does not mark its requests as untraced, so an error event sent from inside a failing request would become a child span carrying `traceparent`. Add your Sentry ingest host to `ignore.outgoing` (see the `ignore` sample above). Requests Sentry makes outside a request are skipped already, because they have no parent span.

**Other OpenTelemetry instrumentations.** Upstream `@opentelemetry/instrumentation-*` packages (Kafka, AMQP, MongoDB, gRPC) use the same API and join the same traces. You set them up as their documentation says; Nestrix neither manages nor requires their loader flags.

## CommonJS apps

A CommonJS Nest 12 app loads `@nestrix-js/nestjs` with `require()` (Node's `require(esm)`), and the package has no top-level `await` so that works. Things to know:

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

- **Install size.** The packed `@nestrix-js/nestjs` tarball is 169 kB (630 kB unpacked in 122 files; `npm pack --dry-run`). The total installed size was measured on 2026-11-11: installed with `npm install --omit=dev` into a fresh directory, a Nest host stack (`@nestjs/common`, `core`, `platform-express`, `reflect-metadata`, `rxjs`) was 21.1 MB, and adding `@nestrix-js/nestjs` brought it to 40.9 MB: **19.8 MB added**. That includes `@opentelemetry/api`, the peer dependency, which a host without OpenTelemetry has to install anyway (1.9 MB). The largest single item is `@opentelemetry/semantic-conventions` at 9.6 MB; the rest is the OpenTelemetry SDK packages. Sizes are disk blocks (`du -sk`). The dashboard adds `@nestrix-js/ui`: a 255 kB tarball, about 760 kB unpacked in 11 files (one 655 kB script, one 26.7 kB stylesheet), with no dependencies of its own.
- **Startup.** Time from process spawn to the first `200` on `GET /hello`, 15 fresh processes per configuration: 268.8 ms uninstrumented, 318.8 ms with Nestrix exporting to a local OTLP endpoint (**about 50 ms added**), 320.3 ms with Nestrix and no endpoint (51.5 ms added). Export is asynchronous, so a slow or absent collector does not delay startup. Those runs loaded the OTLP exporter at startup; it is now loaded only when export is on. Measured again that way (20 fresh processes, export off, a later run on the same machine): 246.1 ms uninstrumented, 278.8 ms with Nestrix and the dashboard off (**32.7 ms added**; 295.2 ms, 49.1 ms added, when the exporter is loaded eagerly as before), and 282.9 ms with the dashboard on (36.8 ms added). Idle heap is 1.1 MB lower than when the exporter was loaded at startup (export is off in both configurations).
- **Exporter outage.** Ten minutes at 3,000 requests/s with the OTLP endpoint refusing connections, and again with it accepting requests and never answering: retained heap stayed flat (slope 0.01 and 0.03 MB/min, about 2 MB above a healthy run, which is the queue), and at most two collector connections were open at once. Spans beyond the queue are dropped and counted, not buffered.

## Licence

[Apache-2.0](../../LICENSE)
