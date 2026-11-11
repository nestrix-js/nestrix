# Getting started

Nestrix needs NestJS 12 and Node.js 26.13 or later. See [Compatibility](/reference/compatibility) for the full list.

## Install

```bash
pnpm add @nestrix-js/nestjs @opentelemetry/api@~1.10.0
```

`@opentelemetry/api` is a peer dependency, so your app and Nestrix share one copy. Nestrix also needs `reflect-metadata` and `rxjs`, which a Nest app already has.

The dashboard is a separate, optional package. Install it at the same version as `@nestrix-js/nestjs`:

```bash
pnpm add @nestrix-js/ui
```

The packages are ESM-only. A CommonJS Nest 12 app loads them with `require()`, which works because they have no top-level `await`.

## Import one module

Register the module once, in your root module. It is global.

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

Import `NestrixModule` before other modules that register a global interceptor (`APP_INTERCEPTOR`). Nest runs global interceptors in module order, and an interceptor that runs first can throw an error Nestrix never sees: the request's span then has no route name for a 404 and no exception event.

With no configuration Nestrix creates spans and keeps them in memory, but **exports nothing**. Export is on only when an endpoint is set. At startup Nestrix logs one line saying so.

Use `forRootAsync` when options come from another provider:

```ts
NestrixModule.forRootAsync({
  imports: [SettingsModule],
  inject: [Settings],
  useFactory: (settings: Settings) => ({
    serviceName: "my-api",
    export: { otlp: { endpoint: settings.otlpEndpoint } },
  }),
});
```

## Your first trace in the dashboard

Start the app in development (`NODE_ENV` unset or `development`) with `@nestrix-js/ui` installed. When the app starts listening, Nestrix logs one line:

```text
Nestrix dashboard: http://localhost:3000/_nestrix/auth?token=<43 characters>
```

Open that link in a browser on the same machine. Nestrix checks the token, sets a session cookie and redirects to `/_nestrix/`. Send a request to your app (`curl http://localhost:3000/`) and it appears in the request list within two seconds. Click it for the span waterfall.

Each start creates a new token, so after a restart, open the new link. The rules behind this are on the [Security model](/guide/security) page.

## Your first trace in Jaeger

Run Jaeger v2, which accepts OTLP over HTTP on port 4318 and serves its UI on 16686:

```yaml
# docker-compose.yml
services:
  jaeger:
    image: jaegertracing/jaeger:2.23.0
    ports:
      - "16686:16686" # query UI
      - "4318:4318" # OTLP over HTTP
```

```bash
docker compose up -d
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node dist/main.js
```

`/v1/traces` is appended to the endpoint. Send a request, then open `http://localhost:16686`, choose your service name and find the trace.

Spans leave the process in batches, in the background, through a bounded queue. Nothing in a request waits on the collector, and when the queue is full new spans are dropped and counted.

Call `app.enableShutdownHooks()` if you rely on `SIGTERM` and `SIGINT` to close the app: closing flushes buffered spans (for at most 5 seconds).

## Next steps

- [Levels 1 to 3](/guide/levels): add method spans, database and cache spans, and BullMQ jobs.
- [Dashboard](/guide/dashboard): what each view shows.
- [Configuration reference](/reference/configuration): every option.
