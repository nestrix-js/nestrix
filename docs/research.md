# Research notes

Facts the architecture rests on, checked on **2026-11-11**. NestJS 12, OpenTelemetry JS SDK 3 and Node 26 are newer than most model training data, so treat this file and live sources as more reliable than memory. If a fact here matters to a decision and may have moved, re-check it first (see "Re-verifying" at the end) and update this file with the new date.

Confidence tags:
- **[V]** read in a primary source (npm manifest, source file, official docs, published type declarations).
- **[S]** secondary source (blog, search summary, third-party claim).
- **[U]** not verified. Treat as a hypothesis.

Hook signatures and per-adapter behaviour have their own file: [nest-hooks.md](nest-hooks.md).

## 1. NestJS 12

| Fact | Tag | Source |
|---|---|---|
| Stable. 12.0.0 published 2026-08-27; latest 12.4.2 (2026-11-09). 11.x still gets backports (11.2.9). | V | registry.npmjs.org/@nestjs/core |
| Every `@nestjs/*` v12 package is ESM-only: `"type": "module"`, `exports` has no `require` condition. Core's `exports`: `"."`, `"./*"`, `"./*.js"`, `"./internal"`, `"./package.json"`. | V | registry manifest of 12.4.2 |
| CommonJS apps keep working through `require(esm)`. Known gotchas: AWS Lambda disables it on its Node 20/22/24 runtimes (needs `NODE_OPTIONS=--experimental-require-module`); Jest needs `--experimental-vm-modules` (the `@nestjs/schematics` 12.0.13 CommonJS starter runs `node --experimental-vm-modules ./node_modules/jest/bin/jest.js`) and then loads v12 on Node 24.9+; on 22.x it needs a transform such as `@swc/jest`. Without the flag Jest 30.5.2 fails on every Node with `Must use import to load ES Module` (also with its default babel-jest transform). The gate is `jest-runtime@30.5.2/build/index.js:4442-4444` (`vm.SourceTextModule?.prototype.hasAsyncGraph`, absent on 22.15.0). Vitest works unchanged. | V | migration guide; spike P0-S4, 2026-11-11 |
| Runtime: Node 20.19+ or 22.12+ (21.x unsupported). The CLI needs `^22.22.3 \|\| ^24.15.0 \|\| >=26`. | V | migration guide; @nestjs/schematics manifest |
| TypeScript 6 (`@nestjs/schematics` peers `typescript >=6.0.0`). Decorators are still the legacy kind: the starter sets `experimentalDecorators` and `emitDecoratorMetadata`. | V | starter tsconfig; manifests |
| The registry's `latest` has moved past the majors this project targets: `typescript` 7.0.2 (newest 6.x: 6.0.3) and `vitest` 5.1.0 (newest 4.x: 4.1.12). The workspace pins `^6.0.3` and `^4.1.12` (P0-01); moving to either new major is a separate decision. | V | `npm view`, 2026-11-11 |
| TS 6.0.3: `verbatimModuleSyntax` works with legacy decorators. A value import of a class used as a constructor parameter still emits `design:paramtypes [Dep]`; `import type` of that class compiles silently and emits `Function`, which breaks Nest DI. TS 6 defaults `target` to `es2025` (past Node 22's V8) and `esModuleInterop` to true. | V | compiled and inspected emit, P0-01 |
| Adapters: Express 5.3, Fastify 5.12, and a third, `@nestjs/platform-node` (plain `node:http`, first published 12.3.0 on 2026-10-27). Docs recommend platform-node from 12.3 and say it becomes the default in v13. Its request/response carry Express-style helpers. | V | manifests; docs.nestjs.com/http/performance |
| platform-node 12.4.2 is chosen by passing `new NodeAdapter()` (exported from `@nestjs/platform-node`; app type `NestNodeApplication`) to `NestFactory.create`; without it Nest falls back to Express. Its README does not say so; the `.d.ts` does. It leaves a multipart body unread for the handler. | V | `adapters/node-adapter.d.ts`; examples/node-esm (P0-04) |
| Fastify (via `@nestjs/platform-fastify` 12.4.2, bundling fastify 5.12) needs a `multipart/form-data` content-type parser before it will pass a multipart request to Nest. `@nestjs/platform-express` 12.4.2 bundles multer 2.5.0; `@nestjs/platform-fastify` has no multipart dependency. | V | manifests; examples/fastify-esm (P0-04) |
| `@nestjs/serve-static` 12.1.1 registers its static middleware with `use()` and a `GET {*any}` SPA fallback from its module's `onModuleInit`, which can shadow routes registered later on Express and platform-node. | V | spike P0-S5 |
| `app.useSecurityHeaders()` (12.4.2) installs through `registerSecurityHook()` when called (a `use()` on Express and platform-node, an `onRequest` hook on Fastify). Defaults include `Strict-Transport-Security`, `X-Frame-Options: SAMEORIGIN` and a Helmet-style CSP. That it must be called before `init()` is read from source, not run. | V / source | spike P0-S5 |
| `HttpAdapterHost.init$` is public (`@publicApi`), but its JSDoc says it is emitted when the HTTP application is initialised while the code emits when the adapter is set, before `init()`. A subscriber that throws is rethrown by RxJS asynchronously as `uncaughtException`. | V | spikes P0-S1, P0-S5 |
| `@nestjs/platform-node` 12.3.0 is the first release; async context across its body parsers needs 12.3.2 (run; 12.3.1 by source). The guarded request-hook runners on Express and Fastify start at 12.1.3 (source). `@nestjs/*` 12.0.0 manifests declare their Nest peers as `^11.0.0`. | V | spike P0-S1 |
| Defaults for new projects: Vitest 4 for ESM projects (Jest for CommonJS), oxlint, Rspack for monorepos. `nest new` asks CJS or ESM. | V | migration guide; typescript-starter |
| Lifecycle hooks are called by component hierarchy level in v12; do not rely on `onModuleInit` order between modules. | V | migration guide |
| `app.useSecurityHeaders()` exists from 12.1 (Helmet 8 defaults). | V | docs.nestjs.com/security/helmet |
| Nest loads optional packages with `await import(packageName)`. | V | packages/common/utils/load-package.util.ts |
| Ecosystem peers: `@nestjs/bullmq` 12.0.1 (`^10 \|\| ^11 \|\| ^12`), `@nestjs/swagger` 12.1.1 (`^12`), `@nestjs/serve-static` 12.1.1 (`^12`), `@nestjs/terminus` 12.1.0, `@nestjs/graphql` 14.2.0 (`^12`), `nestjs-cls` 7.0.2, `nestjs-pino` 5.3.1. | V | npm manifests |
| Weekly downloads of `@nestjs/core` by major: 11.x 59%, 12.x 21%, 10.x 16%, older 4%. | V | api.npmjs.org/versions/@nestjs%2Fcore/last-week |

Which version introduced which hook (checked in the published `.d.ts` files on unpkg):

| Hook | Present from |
|---|---|
| `setOnRequestHook`, `setOnResponseHook`, `setOnRouteTriggered` on the adapters | 11.2.9 has them; 12.0.0 has them |
| `instrument: { instanceDecorator }` on `NestFactory` | 11.1.4 (absent in 11.1.3) |
| `ClientProxy#setOnDispatchHook` and `PacketMetadata` | `@nestjs/microservices` 12.0.4 (absent in 12.0.0 and 11.2.9) |
| Header-based metadata transports (NATS, Kafka, RabbitMQ, MQTT 5, gRPC) | 12.3.3 per the Observe docs [S for the exact version] |

## 2. The Nest team's own product: `@nestjs/observe`

| Fact | Tag |
|---|---|
| Hosted APM. Collector at `observe-api.nestjs.com`, dashboard at `observe.nestjs.com`. No self-hosted backend. Free up to 300,000 events a month; paid plans above. | V (docs.nestjs.com/observability/sdk, github.com/nestjs/observe README) |
| The default `nest new` starter depends on it. | V (typescript-starter) |
| Setup: `ObserveModule.forRoot(...)` plus `NestFactory.create(AppModule, { instrument: ObserveInstrument })`. No preload flag. | V |
| It records database spans at the driver (`pg`, `mysql2`, `mssql`, `mongodb`) and outbound HTTP from Node's diagnostics channels. One runtime dependency; no OpenTelemetry SDK. | V (docs; manifest) |
| It exports traces only over OTLP/HTTP, and does not ingest OTLP. | V (docs.nestjs.com/observability/opentelemetry) |
| Licence: MIT up to and including 0.3.20 (2026-10-29). From 0.3.21 (2026-10-30) the "NestJS Observe Agent License": use only to send telemetry to their service; may not be used "to develop, test, document or operate a collector, backend or service that receives Telemetry from the Software, or that substitutes for the Service". | V (LICENSE in the 0.3.25 tarball; registry `license` field per version) |

Consequence: the clean-room rule in [CONTRIBUTING.md](../CONTRIBUTING.md). Nobody working on Nestrix, human or model, opens, installs or runs `@nestjs/observe` later than 0.3.20.

## 3. Node.js

| Fact | Tag |
|---|---|
| Release lines: 26 Active LTS since 2026-10-28; 24 maintenance (EOL 2028-04-30); 22 maintenance (EOL 2027-04-30); 20 EOL 2026-04-30. | V (nodejs/Release schedule.json) |
| `require(esm)` unflagged from 20.19 / 22.12; stable since 25.4. It fails on modules with top-level `await` (`ERR_REQUIRE_ASYNC_MODULE`, also when the `await` is in a statically re-exported module). | V (nodejs.org/api/modules.html; spike P0-S4) |
| On 22.15.0, 24.22.2 and 26.13.0, `require()` of an ESM-only graph (Nest 12, OpenTelemetry SDK 3 packages, `instrumentation-undici`) prints no warning and needs no flag. | V (spike P0-S4) |
| `module.registerHooks()` is Release Candidate (added 22.15 / 23.5). `module.register()` is runtime-deprecated in 26 (DEP0205). `--experimental-loader` is "discouraged and may be removed". | V |
| `TracingChannel` stable since 26.8.0. `AsyncLocalStorage` uses `AsyncContextFrame` by default since 24.0. | V |
| Built-in HTTP diagnostics channels (plain channels, Experimental): `http.client.request.created` ("emitted before the request has been sent"), `http.client.request.start`, `http.client.request.error`, `http.client.response.finish`, `http.server.request.start`, `http.server.response.created`, `http.server.response.finish`. Present in the Node 22 docs. | V (nodejs.org/docs/latest-v22.x/api/diagnostics_channel.html) |
| Whether a subscriber may set headers on the `ClientRequest` in `http.client.request.created` is not documented. | U (spike 2) |
| A subscriber that throws raises `'uncaughtException'`. Subscribers run synchronously in the publisher's context. | V |
| `node:sqlite` is Release Candidate. | V |

## 4. OpenTelemetry JS

| Fact | Tag |
|---|---|
| SDK 3.x is current: 3.0.0 / 0.300.0 on 2026-10-20; 3.1.1 / 0.301.1 on 2026-11-09. Engines `node >=22.15.0`. | V (npm) |
| `@opentelemetry/api` is 1.10.0. SDK 3.x peers `>=1.10.0 <1.11.0`; SDK 2.x peers `<1.10.0`. The two generations cannot share one install. SDK 2.x gets fixes until 2027-09-30. | V |
| Every OpenTelemetry JS package checked has dual builds (`.cjs` for `require`, `.mjs` for `default`; `require` listed first, no `module-sync`). A CommonJS host and the ESM `@nestrix/nestjs` therefore load two instances of `@opentelemetry/api` and of the SDK. They share the global provider and the context keys (`Symbol.for`), so spans and parents cross the boundary, but `instanceof` across it is `false`. | V (spike P0-S4) |
| SDK 3's `TracerProvider` defaults to `ParentBased(AlwaysOn)` (`sdk-trace/dist/TracerProvider.mjs:24`, 3.1.1). `Span.isRecording()` is `!this._ended` (`Span.mjs:202`), so it turns false when a sampled span ends. | V (spike P0-S6) |
| `sdk-trace-base` and `sdk-trace-node` are gone; use `@opentelemetry/sdk-trace`. Every package has an `exports` map; deep imports fail. | V (3.x announcement and changelog) |
| Traces and metrics are stable. Logs: `sdk-logs` marked stable in 3.0.0, while opentelemetry.io still says "Development". | V (conflicting sources) |
| `addSpanProcessor` was removed in SDK 2.0. A `TracerProvider` takes `spanProcessors` only in its constructor. There is no public way to add a processor to a provider someone else built. | V |
| `trace.setGlobalTracerProvider()` returns `false` if a provider is already registered. `ProxyTracerProvider` is deprecated, so `getDelegate()` is not a durable detection path. | V (api source) |
| Official ESM instrumentation command today: `node --experimental-loader=@opentelemetry/instrumentation/hook.mjs --import ./telemetry.js app.js`. On Nest 12, CommonJS apps need the loader flag too, because the Nest packages are ESM. `module.registerHooks()` is not adopted (issue #4933 open since 2024-08; PR #6922 unreviewed). | V (opentelemetry-js doc/esm-support.md) |
| A first-line `import './instrument.js'` in an ESM entry point is too late for module patching: the static graph is loaded before anything is evaluated. | V (import-in-the-middle README) |
| ESM instrumentation fails silently when instrumentations and host do not share one `import-in-the-middle` copy (issue #7237, 2026-10-27). | V as filed |
| `@opentelemetry/instrumentation-nestjs-core` 0.72.0 peers `@nestjs/core >=4.0.0 <12`. It creates three spans (`Create Nest App`, `<Controller>.<method>`, `<method>`) by patching `NestFactoryStatic.create` and `RouterExecutionContext.create`: HTTP routes only, nothing for microservices, gateways, GraphQL, guards, pipes or interceptors. Nest 12 support was merged 2026-09-10, reverted 2026-10-15; replacement PR #3859 is open and will need the ESM hook. | V |
| `@opentelemetry/instrumentation-undici` 0.35.0 subscribes to `undici:request:*` channels. It needs no module patching. Depends on `@opentelemetry/core ^3`, `@opentelemetry/instrumentation ^0.301`, `semantic-conventions`. 104 kB unpacked. | V |
| Other contrib instrumentations checked (http, express, pg, mysql2, mongodb, ioredis, redis, knex, typeorm, mongoose, graphql, kafkajs, amqplib, grpc) are patch-based. `@opentelemetry/instrumentation-fastify` is deprecated; `@fastify/otel` 1.0.1 is the official one. | V |
| Package sizes and licences: `sdk-trace` 3.1.1 422 kB; `resources` 234 kB; `exporter-trace-otlp-proto` 38 kB (plus `otlp-transformer`, `otlp-exporter-base`); `instrumentation` 312 kB (depends on `import-in-the-middle`, `require-in-the-middle`). All Apache-2.0. | V |
| `@opentelemetry/otlp-transformer` 0.301.1 exports serialisers only (`serializeRequest`, `deserializeResponse`). It cannot decode an incoming OTLP request, and it no longer depends on protobufjs. | V |
| `auto-instrumentations-node` 0.83.0 has 49 direct dependencies, 41 of them instrumentations. | V |
| Overhead: one synthetic benchmark (Node 24.4) puts `AsyncLocalStorage` alone near 7% throughput on a trivial Fastify route, and full auto-instrumentation at 18.6% of baseline throughput. | S (blog.platformatic.dev/the-hidden-cost-of-context) |
| `@sentry/node` 11.12 no longer registers a tracer provider by default; it depends only on `@opentelemetry/api ^1.9.1`. Its documented custom setup: initialise OpenTelemetry first, then `Sentry.init({ enableOpenTelemetrySetup: false, integrations: [Sentry.openTelemetryIntegration()] })`. Sentry's blog calls the integration `otlpIntegration()`: the two sources conflict. | V / conflicting |

## 5. Libraries that publish their own tracing events

| Library | State | Tag |
|---|---|---|
| undici / global `fetch` | `undici:request:*` channels | V |
| Fastify 5 | `fastify.initialization`, TracingChannel `tracing:fastify.request.handler` | V |
| mysql2 | TracingChannels `mysql2:query`, `execute`, `connect`, `pool:connect` since 3.20.0 (2026-03-14) | V (PR #4178) |
| ioredis | `ioredis:command`, `ioredis:connect` since 5.11.0 (2026-05-26) | V (PR #2089) |
| node-redis | Channels merged 2026-04-02; release version not confirmed | V merge |
| mongoose | TracingChannel merged 2026-06-03; release not confirmed | V merge |
| graphql-js 17 | TracingChannel merged 2026-06-02 | V merge |
| `@platformatic/kafka` 2.15 | `plt:kafka:*` tracing channels | V |
| `pg` | None yet. PR #3650 open, last activity 2026-10-09. | V |
| knex | None yet; PR aimed at 4.0 | V |
| mongodb driver, bullmq, kafkajs | No channel work found | U |
| BullMQ 6.7 | Built-in telemetry: `telemetry: new BullMQOtel('name')` on Queue and Worker options (`bullmq-otel` 2.0.1, MIT, peers `bullmq >=6.0.0`, depends on `@opentelemetry/api ^1.9.1`). | V |
| `@nestjs/bullmq` 12.0.1 | `BullRootModuleOptions extends Bull.QueueOptions`, so `telemetry` is accepted at `forRoot`; shared config is spread into each queue's options; the explorer forwards `queueOpts.telemetry` to workers and queue events. | V (nestjs/bull source) |
| Drizzle ORM 0.45.4 | Emits no spans: the `@opentelemetry/api` import in its `tracing.ts` is commented out. Driver-level spans are what you get. | V |
| Prisma 7 | With `@prisma/adapter-pg` the query engine runs its SQL "via the JavaScript database driver" (`pg`). Whether adapters are mandatory in v7 was not stated on the page read. `@prisma/instrumentation` 7.10.1 depends on `@opentelemetry/instrumentation ^0.207`, a second copy beside a 0.301 host. | V / U |
| MikroORM 7 | No OpenTelemetry package found. | U (negative search) |

## 6. Existing NestJS tools

| Tool | Version, date | Licence | Adoption | Nest | UI |
|---|---|---|---|---|---|
| nestjs-otel | 8.1.1, 2026-09-07 | Apache-2.0 | 800 stars, ~470k/wk | `>=11 <13` | None |
| @amplication/opentelemetry-nestjs | 7.0.0, 2026-10-03 | MIT | 42 stars | 10–12 | None |
| nestlens | 0.14.2, 2026-08-24 | MIT | 47 stars, ~6k/wk | 9–11 | Embedded at `/nestlens`; CommonJS; SQLite; not OpenTelemetry |
| @sentry/nestjs | 11.12.0 | MIT | — | 8–12 | Hosted |
| @nestjs/devtools-integration | 12.0.0 | MIT | ~109k/wk | 12 | Hosted; dependency graph, not telemetry |

No embedded dashboard supports Nest 12 or builds on OpenTelemetry. [V from npm and GitHub metadata]

Local OTLP viewers to be aware of (licences [V], descriptions [U]): otel-tui, otel-desktop-viewer (Go, DuckDB, Svelte 5), .NET Aspire Dashboard (in memory, default 10,000 traces [S]), grafana/otel-lgtm, Jaeger v2 all-in-one, HyperDX/ClickStack, SigNoz, OpenObserve (AGPL), Uptrace (AGPL).

## 7. How embeddable dashboards ship and mount

| Tool | UI stack | Packaging | Base path |
|---|---|---|---|
| `@bull-board/ui` 9.13.0 | React 19.3, Rsbuild, TanStack Query, Base UI, Recharts | Prebuilt `dist/` in the package; 3.1 MB unpacked | Server renders `<base href>` and a JSON config block |
| `@nestjs/swagger` 12.1.1 | `swagger-ui-dist` | Ordinary dependency | HTML generated at runtime; routes added with `httpAdapter.get()` |
| `@scalar/nestjs-api-reference` 1.2.36 | None bundled; loads from a CDN | 20 kB | User picks the path |
| nestlens 0.14.2 | React 18, Vite, Tailwind | Built SPA in the library; 2.1 MB | Vite `base: './'` plus injected `<base href>` |
| Laravel Telescope / Horizon | Vue 3, Vite | Prebuilt assets inlined into a Blade layout | Config injected as a global |
| Jaeger UI 2.23 | React 19.3, antd, Vite 8 | — | — |

All [V] from the packages' source or manifests.

Per-adapter behaviour [V by reading source, not by running it]:
- `@nestjs/swagger` branches only on `getType() === 'fastify'` (registers the optional peer `@fastify/static`); everything else, including platform-node, takes the `app.use` + `useStaticAssets` path. Global prefix applies only with `useGlobalPrefix: true`. It registers `path`, `path/` and `path/index.html` by hand because Fastify does not resolve the trailing slash.
- `@bull-board/nestjs` has Express and Fastify branches and no platform-node branch; it prepends the global prefix by default.
- `@nestjs/serve-static` has express, fastify, node and noop loaders. SPA fallback differs per adapter (`exclude` unsupported on Fastify).
- Under Helmet defaults, same-origin assets work; inline scripts and CDN assets need exceptions. `upgrade-insecure-requests` breaks plain-HTTP access by IP.
- Creating a second Nest app with `logger: false` silences the host's logger (`Logger.overrideLogger` is static). Do not create a second app.

## 8. Frontend (decided: React + Vite)

Latest stable on the check date [V from npm]: React 19.3.1; Vite 8.3.7 (Rolldown 1.x); TanStack Router 1.170.46, Query 5.107.1, Virtual 3.14.26, Table 9.3.1; Tailwind 4.3.5; shadcn CLI 4.23.0 with Base UI as the default since July 2026; `@base-ui/react` 1.9.0; React Router 8.5.1; Next.js 16.4.6; Preact 11.2.0 (11.0.0 shipped 2026-09-30); Svelte 5.57.3; SolidJS 1.9.19 (2.0 still RC); Vue 3.5.45; Angular 22.2.5.

Sizes, min+gzip [V, bundlephobia, whole-package entry points]: preact 5.0 kB; solid-js 8.6 kB; svelte 10.8 kB; vue 48.1 kB; `@tanstack/react-query` 13.3 kB; `@tanstack/react-router` 31.0 kB; `@tanstack/react-virtual` 10.3 kB. React's own baseline was not measured (roughly 60 kB gzip from memory [U]).

Charts, min+gzip [V]: uPlot 1.6.32 21.9 kB (no npm release since 2025-03); Chart.js 4.6.1 69.6 kB; `@visx/xychart` 50.3 kB; Observable Plot 127 kB; Recharts 3.10.1 150 kB; ECharts 6.1 368 kB.

Next.js static export: `basePath` "must be set at build time and cannot be changed without re-building"; no rewrites, redirects or dynamic routes without `generateStaticParams()`. [V] This is why it was ruled out.

Trace-waterfall components: a few React packages exist with little adoption; none found for Svelte or Solid. The waterfall is built in-house.

## 9. Storage and OTLP ingest (phase 5)

| Fact | Tag |
|---|---|
| Drizzle ORM `latest` is 0.45.4 (2026-10-08). 1.0 is still a release candidate (rc.5, 2026-10-21). `drizzle-orm/node-sqlite` exists only in the 1.0 RC. | V |
| drizzle-kit has no declarative partition support (issue #2854, open since 2024-08-27). Partition DDL means hand-written SQL migrations. | V for the issue; the implication is inferred |
| PostgreSQL current major is 18 (18.6, 2026-08-13). | V |
| Promscale (Timescale's traces-and-metrics-on-Postgres product) is discontinued; repo archived 2024-04-02. | V |
| No primary-source guidance on PostgreSQL span-table limits was found. The supported envelope has to be measured. | — |
| OTLP/HTTP spec 1.11: servers must accept gzip; content types `application/x-protobuf` and `application/json`; JSON uses hex ids and string 64-bit integers; partial success is HTTP 200 with `rejected_*`; retry on 429/502/503/504 with optional `Retry-After`; 64 MiB body limit, 413 beyond it. | V |
| Decoding options: `@bufbuild/protobuf` 2.17 with generated code; protobufjs 8.8; ts-proto 2.18. No ready-made npm decoder package was found. Existing Node receivers to read for ideas: `autotel-devtools`, trigger.dev's `otlp-importer` (neither was read). | V for versions |

## 10. Project name (checked 2026-11-11 with the owner's go-ahead)

- npm: unscoped `nestrix` is free; no package is published under `@nestrix`. Whether the scope itself is registered cannot be seen from outside.
- GitHub: `github.com/nestrix` is a dormant organisation (created 2012, linked to nestrixcorp.com). The owner chose the `nestrix-js` organisation; repository `github.com/nestrix-js/nestrix`.
- A company called Nestrix appears to exist. A trademark search is advisable before a public release.

## 11. Open questions

These are not known. Each is assigned to a spike in [backlog/phase-0.md](backlog/phase-0.md) or a later phase.

- Does async context survive body parsing on each adapter when the request hook wraps `done()`?
- Can a `http.client.request.created` subscriber set headers?
- Does the `pg` wrapper reach the right module instance when an ORM carries a nested copy of `pg`?
- Does Prisma 7 always go through the `pg` adapter?
- Does a module-registered global interceptor cover microservice handlers in a hybrid app?
- Under `@nestjs/testing`, is the HTTP adapter available when providers are constructed?
- How do OpenTelemetry SDK 2.x hosts adopt Nestrix, given the peer ranges do not overlap?
- Install size and startup cost of the dependency set, and of `auto-instrumentations-node` for comparison.

## Re-verifying

```bash
# Manifest facts (version, type, exports, engines, peers, licence)
curl -s https://registry.npmjs.org/<package>/latest
# A published file at an exact version
curl -sL https://unpkg.com/<package>@<version>/<path>
# NestJS source on the 12.x line
curl -s https://raw.githubusercontent.com/nestjs/nest/master/packages/<path>
```

Never fetch, read, install or run `@nestjs/observe` later than 0.3.20 (the clean-room rule).
