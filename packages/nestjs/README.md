# @nestrix/nestjs

Nest-aware OpenTelemetry tracing for NestJS 12+. Add one module and your app produces a server span per request, outgoing HTTP spans, and your own spans, exported over OTLP to whatever backend you run (Jaeger, Tempo, an OpenTelemetry Collector, a vendor that accepts OTLP).

> **Status: 0.1.0-alpha, headless tracing only.** The dashboard, the `instrument` hook for controller, guard and job spans, library spans (`pg`, `mysql2`, `ioredis`) and microservice spans come in later releases. Option names may still change before 1.0.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Options](#options)
- [Environment variables](#environment-variables)
- [What is traced](#what-is-traced)
- [Custom spans](#custom-spans)
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

If your app registers its own tracer provider before Nestrix starts (that is, before `NestFactory.create` constructs the module), Nestrix does not create an SDK. Its spans go through your provider and your exporters. In that case `sampleRate` and every `export.*` option are ignored, `redact` is not applied (see [Privacy](#privacy)), and Nestrix logs one line saying so. Your SDK must be OpenTelemetry JS SDK 3.

Nestrix registers its OpenTelemetry globals during `NestFactory.create`, never at import time or when `forRoot()` runs. If you start your SDK in the body of `main.ts` after importing `AppModule`, start it before `NestFactory.create`.

## Options

Every option is optional. `NestrixModule.forRoot(options?)` and the object `forRootAsync`'s factory returns take the same shape. Invalid values (for example a `sampleRate` outside 0 to 1, or a non-positive queue size) throw when the module is created, at startup.

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
| `redact` | none | A synchronous hook that sees every exported span. |

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

A matcher is a string, a `RegExp` or a function. A `RegExp` is tested with `search`, so the `g` flag and `lastIndex` do not matter. A function receives the path or URL and must return `true` to match. A matcher that throws counts as a match, and the failure is counted.

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

A hook for the spans Nestrix exports. See [Privacy](#privacy).

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

An option always wins over the variable of the same meaning. Other `OTEL_*` variables are not read by Nestrix. When your app owns the SDK, the export variables are your SDK's business, not Nestrix's.

## What is traced

- **Incoming HTTP.** One server span per request, named `METHOD /route/template` (or `METHOD` when no route matched, as for a 404), with the OpenTelemetry HTTP attributes, `code.function.name` (`Controller.handler`), the status, and the first exception a handler or pipe threw as an exception event. An incoming `traceparent` is continued. If the client goes away before the response finishes, the span carries `nestrix.http.aborted = true`.
- **Outgoing HTTP.** `node:http` and `fetch` (undici) calls get a client span named `METHOD`, and a `traceparent` header unless the request already has one. A request made with no active parent span gets no span and no header, so background traffic (a health poller, an error reporter's transport outside a request) is not traced. If the response body is never read, the span ends at the response head after 30 seconds and carries `nestrix.http.body = "not consumed"`. A body the caller cancels after the response head is marked `"cancelled"` and is not an error.
- **Process errors.** An uncaught exception or unhandled rejection becomes an exception event on the active request span, or a short span of its own. Best effort: the process usually exits before that span is exported. Nestrix adds an `uncaughtExceptionMonitor` listener only and never changes whether the process crashes.
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

`redact(span)` is called for every span Nestrix exports, after Nestrix's own redaction. It receives an editable copy: `name`, `kind`, `attributes`, `events` (each with editable `attributes`) and `status` (`code`, `message`). Return `false` to drop the span; return anything else to keep it with your edits. Links and their attributes are not exposed; to keep them out, drop the span.

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
- It runs when a batch is exported, on the batch timer, not in the request. So spans wait **unredacted** in the in-memory queue until their batch is exported.
- **It is not applied when your app owns the SDK.** Then your own exporters send the spans, and Nestrix cannot redact what they send.

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
| Node.js | 22.15 and later |
| NestJS | 12 |
| `@nestjs/platform-express`, `@nestjs/platform-fastify` | from 12.0.0 |
| `@nestjs/platform-node` | from 12.3.2 (12.3.0 and 12.3.1 lose the request context after JSON body parsing) |
| OpenTelemetry JS | SDK 3 only |

Notes:

- Header versioning with two versions of one route does not boot on Fastify with Nest 12.0.0. That is Nest itself, not Nestrix.
- Before Node 24.20, a response cut off by the client after the app finished writing is detected from the request's socket state instead. It is tested on 22.15 and 26.
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

**One hook-based APM per process.** Nest's request hook is a single slot with no getter, so two tools that install it replace each other. Nestrix checks at startup whether another tool set Nest's hooks and logs a warning. Other tools that use only the OpenTelemetry API or diagnostics channels are fine.

**Sentry.** Nestrix and Sentry run side by side, but with Sentry's defaults `@sentry/node` registers no OpenTelemetry provider, so each of the two starts its own trace: a request has two traces, and an outgoing call carries both Nestrix's `traceparent` and Sentry's `sentry-trace` and `baggage` headers on different trace ids. Sentry does not continue an incoming `traceparent`.

If you want one trace, tested with Sentry 11 on Express: `Sentry.init({ dsn, defaultIntegrations: false, integrations: [Sentry.openTelemetryIntegration()] })`, after Nestrix has registered its provider. The cost is that Sentry loses its default integrations (uncaught exception and unhandled rejection capture, `linkedErrors`, `dedupe`, `contextLines`, `localVariables`, breadcrumbs and others), so you must add back the ones you need. With `openTelemetryIntegration()` and Sentry's default integrations, you still get two traces. Setting `enableOpenTelemetrySetup: true` is not supported: Nestrix's context does not survive Sentry's Express instrumentation there.

Sentry's transport does not mark its requests as untraced, so an error event sent from inside a failing request would become a child span carrying `traceparent`. Add your Sentry ingest host to `ignore.outgoing` (see the `ignore` sample above). Requests Sentry makes outside a request are skipped already, because they have no parent span.

**Other OpenTelemetry instrumentations.** Upstream `@opentelemetry/instrumentation-*` packages (Kafka, AMQP, MongoDB, gRPC) use the same API and join the same traces. You set them up as their documentation says; Nestrix neither manages nor requires their loader flags.

## CommonJS apps

A CommonJS Nest 12 app loads `@nestrix/nestjs` with `require()` (Node's `require(esm)`), and the package has no top-level `await` so that works. Things to know:

- **Jest** needs `node --experimental-vm-modules node_modules/jest/bin/jest.js`, and then loads ESM packages on Node 24.9 and later. On Node 22.x it needs a transform that compiles ESM dependencies, such as `@swc/jest`. Without either, Jest fails with `Must use import to load ES Module`. Vitest works unchanged.
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

TBD (P1-13)

## Licence

[Apache-2.0](../../LICENSE)
