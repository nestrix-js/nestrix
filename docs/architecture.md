# Architecture

The canonical description of what Nestrix is and how it is built. It supersedes the planning document it grew from. Decisions and who made them are logged in [decisions.md](decisions.md); the facts behind them are in [research.md](research.md) and [nest-hooks.md](nest-hooks.md); the order of work is in [roadmap.md](roadmap.md).

Several mechanisms below are marked **(spike)**. They are designed from reading source, not yet proven by running code. Phase 0 exists to prove or correct them, and this document is updated with the result.

## 1. What Nestrix is

The open-source way to see what a NestJS 12 app is doing: run one install command, import one module, and get Nest-aware OpenTelemetry traces, either in a dashboard served by the app itself or in whatever backend you already run.

Why a NestJS developer would install it:

1. A local dashboard at `/_nestrix` with nothing else to run and no account: requests, their waterfall, errors, slow routes.
2. Standard OTLP out, to Jaeger, Tempo, Grafana, Datadog or an OpenTelemetry Collector, with spans that understand Nest (route templates, controllers, guards, message patterns), on a Nest version the upstream OpenTelemetry instrumentation does not cover.
3. A permissive licence and telemetry you may send anywhere.

Position: the open, OpenTelemetry-native, self-hostable alternative to the Nest team's hosted `@nestjs/observe`, whose licence ties its agent to its own service.

Supported: NestJS 12.0+ (microservice propagation needs `@nestjs/microservices` 12.0.4+, platform-node needs 12.3+), Node 22.15+, Express 5, Fastify 5 and platform-node.

## 2. Scope

| Capability | Decision | Phase |
|---|---|---|
| HTTP monitoring | Build, on Nest's adapter hooks | 1 |
| Exception monitoring | Build: handler exceptions first, guard and filter level with level 2 | 1, 3 |
| Outbound HTTP | Reuse upstream for fetch/undici; small first-party subscriber for `node:http` | 1 |
| Custom tracing | Thin helpers over the OpenTelemetry API | 1 |
| Embedded dashboard | Build | 2 |
| Provider, guard, pipe, interceptor spans | Build, on Nest's `instrument` option | 3 |
| Database and cache | Build thin driver-level spans for `pg`, `mysql2`, `ioredis`. Nothing ORM-specific. | 3 |
| Background jobs | Reuse BullMQ's own telemetry; scheduled jobs through level 2 | 3 |
| Microservices | Build on Nest's packet-metadata hooks | 4 |
| Standalone server | Build | 5 |
| Logs | Correlation ids, then optional OTLP export. Storage and search stay with existing log backends. | 6 |
| Metrics | Delegated to the OpenTelemetry Metrics API. Nestrix adds request-duration and runtime metrics. | 6 |
| Health monitoring | Not built. `@nestjs/terminus` does it. | — |

Deferred, with no phase yet: MongoDB driver spans (candidate: the driver's command-monitoring events), GraphQL resolvers, WebSocket gateways, alerting, profiling, service map, multi-tenancy, an `init` CLI, NestJS 11 support, ClickHouse storage, SQLite persistence for the embedded store.

## 3. One pipeline, three modes

```
 Nest hooks ─┐
 diagnostics ├─► @opentelemetry/api ─► TracerProvider ─┬─► BatchSpanProcessor ─► OTLP/HTTP exporter   (headless, standalone)
 channels    │      (spans, context)   (host's own, or │
 integrations┘                          one Nestrix    └─► store processor ─► bounded in-memory store
                                        creates)                               ─► query API ─► UI      (embedded)
```

- Instrumentation code writes through `@opentelemetry/api` only. It never knows which mode is active.
- A mode is a choice of span processors. Headless is the exporter alone. Embedded adds the in-memory store. Standalone is a separate service that receives the same OTLP.
- The UI talks to one versioned HTTP query API. That API, with its types in `packages/protocol`, is the contract between the UI and whatever serves it. The embedded store and the standalone server each implement the API; they do not share a storage interface until a second implementation shows what it should be.
- Headless and embedded ship together in the first release. Standalone follows in phase 5.

## 4. Design

### 4.1 Integration levels

| Level | What the developer does | What they get |
|---|---|---|
| 1. Module only | `imports: [NestrixModule.forRoot()]` | HTTP server spans with route template and status; exceptions thrown by handlers; outbound HTTP spans and `traceparent` propagation; microservice handler spans and client-side propagation (phase 4); the dashboard; OTLP export |
| 2. One line in `main.ts` | `NestFactory.create(AppModule, { instrument: NestrixInstrument })` | Spans for provider methods, guards, pipes, interceptors and filters; exceptions that never reach a handler; scheduled jobs; queue processors |
| 3. Library spans | Nothing for `pg`, `mysql2`, `ioredis`: each switches on when its library is present and can be switched off. One line of BullMQ's own config for jobs. | Query and command spans, which cover TypeORM, Drizzle, MikroORM and Knex, and Prisma on `@prisma/adapter-pg` **(spike)**. Job spans. |
| 4. Anything else | The user sets up an upstream `@opentelemetry/instrumentation-*` package with the loader flags upstream documents | Kafka client, AMQP, MongoDB driver, gRPC spans. They use the same OpenTelemetry API, so they join the same traces. Nestrix neither manages nor requires the flags. |

The plan states these levels openly instead of promising zero-code instrumentation for everything.

### 4.2 Level 1 mechanics

Read [nest-hooks.md](nest-hooks.md) first; the rules here are consequences of it.

**HTTP server span**
- `setOnRequestHook`: extract W3C context, start the server span, then call `done()` inside the span's context so the rest of the request inherits it. The hook is synchronous, calls `done()` exactly once on every path, and cannot throw.
- The span ends on the raw response's `close` event, attached in the request hook; the listener holds the span itself, because on a client abort it runs outside the request's async context. Status at `close`: `headersSent` true means `statusCode` is what was sent; `writableEnded && !writableFinished` means delivery was cut after the app finished; `!headersSent && !writableFinished` means no response, so no status code is recorded (P0-S1). `setOnResponseHook` is not used.
- Route template from `setOnRouteTriggered`, chained with any existing callback through `getOnRouteTriggered()`. It carries no request, so the active span is found through async context.
- Both hooks are set from a provider constructor, because routes are registered before `onModuleInit`. If no adapter is available at construction (`@nestjs/testing`), the constructor subscribes to `HttpAdapterHost.init$`, which emits when the adapter is set and before routes are registered; both hooks work from that callback. The subscriber's entire body catches everything (a throw there becomes an asynchronous `uncaughtException`). In apps without HTTP `init$` emits `null` or never emits, and nothing is installed. This relies on `init$`'s code, not its JSDoc, so a nightly test on the latest Nest 12.x asserts `http.route` under `@nestjs/testing` (P0-S1).
- A 404 has no route: the span is named by method alone. Under header, media-type or custom versioning, and with host filters, the route hook fires before the filters decline, so a request that no version accepts would otherwise keep a route name. Rule (design inference, not yet run): if the final status is 404 and Nestrix's global interceptor never ran for the request, `http.route` is dropped. Guard rejections keep their name.
- Supported versions: the hook shape above behaves the same on 12.0.0 and 12.4.2 for Express and Fastify. platform-node needs 12.3.2 or later for context across its body parsers (P0-S1); the floor is an owner decision.

**Handler attribution and exceptions**
- A global interceptor, registered by the module, adds controller and handler names and records exceptions thrown by handlers and pipes as span events with status.
- No global exception filter. Exceptions thrown by guards are captured at level 2.
- `uncaughtExceptionMonitor` and `unhandledRejection` listeners record process-level errors without changing behaviour.

**Outbound HTTP**
- fetch and undici: upstream `@opentelemetry/instrumentation-undici`, which is channel-based.
- `node:http` client: a first-party subscriber on Node's `http.client.*` channels. Header injection from `http.client.request.created` is a **(spike)**.

**Sharing hooks with another tool**
- Nest's request hook is a single slot with no getter. Nestrix does not try to chain it. Only one hook-based APM can run per process; Nestrix checks at bootstrap whether another is installed and warns clearly.
- For the `instrument` slot, Nestrix exports `composeInstrument(a, b)`.

**Rules for every hook and subscriber**
- Wrap the whole body. A request hook that throws fails the user's request; a diagnostics-channel subscriber that throws raises `uncaughtException`.
- Failures are counted and logged once, not per request.
- Nestrix's own routes and its exporter's requests are never traced.
- `enabled: false` or `NESTRIX_ENABLED=false` registers nothing at all.

### 4.3 Level 2 mechanics

Nest's `instanceDecorator` sees every DI-created instance after construction and before any explorer captures its methods. Nestrix wraps methods; it does not return a `Proxy`.

Requirements, each backed by a test:
- Wrappers copy all reflect-metadata keys, own properties, `name` and `length` from the original function. Without this a method-level `@UseGuards` becomes invisible and the route fails open.
- The receiver stays the raw instance, so `#private` members and identity checks keep working.
- Wrappers are cached per class, so request-scoped instances cost no closure allocation per request.
- Functions and non-class values pass through untouched.
- Only prototype methods are wrapped, never callable own properties.
- What is wrapped by default is decided by an explicit rule, not by guessing: **(spike)**. Users can always `include` and `exclude` by class or pattern.

An unsampled trace produces non-recording spans, so level 2's cost falls with the sample rate.

### 4.4 Level 3 mechanics

| Library | Mechanism | Needs module access |
|---|---|---|
| mysql2 3.20+ | Subscribe to its TracingChannels | No |
| ioredis 5.11+ | Subscribe to its channels | No |
| `pg` | Wrap `Client.prototype.query` and `Pool.prototype.query` after load. Works without a preload because `pg` is CommonJS and its exports object is shared. Replace with channels when `pg` ships them. | Yes: `pg` is declared as an optional peer so strict package managers let Nestrix resolve it. The nested-copy case is a **(spike)**. |
| BullMQ | Its own `telemetry` option with `bullmq-otel`; `@nestjs/bullmq` forwards it to workers. Nestrix documents it and renders the spans. | No Nestrix code |

Subscribing to a channel nobody publishes costs nothing, so the channel integrations are effectively free when the library is absent. Each integration is a small file with no dependencies of its own, loaded lazily.

Statements are recorded with literals replaced by `?`. Bind parameters are never recorded unless explicitly enabled.

### 4.5 OpenTelemetry usage

**Reused from upstream:** the API; SDK 3.x (`@opentelemetry/sdk-trace`, resources); the OTLP/HTTP exporter; semantic conventions; `@opentelemetry/instrumentation-undici`; `bullmq-otel`.

**First-party, and why:**

| Piece | Why not upstream |
|---|---|
| Nest instrumentation | Upstream does not support Nest 12, patches internals and covers HTTP handlers only |
| `node:http` client spans | Upstream is patch-based; Node publishes channels |
| mysql2, ioredis spans | Upstream is patch-based; both libraries publish channels |
| `pg` spans | Upstream needs experimental loader flags; a small wrapper does not |

This is a deliberate, narrow exception to "do not duplicate mature infrastructure". Each first-party piece is a thin subscriber or wrapper, and the alternative is asking every user for Node flags that are deprecated or discouraged.

**When the host already has an SDK.** Nestrix calls `trace.setGlobalTracerProvider()`. If it returns `false`, a provider exists: Nestrix creates no SDK, its instrumentation keeps working through the API, and export is the host's business. For the dashboard, the host adds `nestrixSpanProcessor()` to its own `spanProcessors`; Nestrix logs that hint. The host's SDK must be 3.x. How hosts on SDK 2.x adopt Nestrix is an open decision ([decisions.md](decisions.md), O-1).

**Sentry.** `@sentry/node` 11 registers no provider by default, so two tracers would each start a trace. The supported setup is decided in spike 3.

**No `instanceof` on OpenTelemetry classes.** A CommonJS host loads the `.cjs` builds of the API and SDK while Nestrix, being ESM, loads the `.mjs` builds: two instances that share globals but not classes (spike P0-S4). Nothing in Nestrix may use `instanceof` on API or SDK classes (spans, providers, processors, exporters, contexts); `nestrixSpanProcessor()` and any check on a host-supplied provider or processor are duck-typed.

**Dependency budget.** At runtime `@nestrix/nestjs` depends on the SDK, resources, the OTLP exporter, `instrumentation-undici` and semantic conventions, with `@opentelemetry/api` as a peer and `pg` as an optional peer. Install size and startup cost are measured in phase 1 and published.

### 4.6 Embedded dashboard

- **Store.** A bounded in-memory ring of recent traces, fed by a span processor. Bounded by trace count and by approximate bytes; oldest evicted first. Nothing is written to disk. Default limits come from measurement in phase 2.
- **Statistics under sampling.** Per-route request count, error count and a duration histogram are recorded in the request path before the sampling decision, so route statistics stay correct at any sample rate. Trace and error lists come from stored spans and are therefore sampled; the UI says so whenever the sample rate is below 1.
- **Mounting.** Routes are registered with the adapter's generic methods (`httpAdapter.get`) in `onModuleInit` (D-31; spike P0-S5 showed constructor-time registration through `HttpAdapterHost.init$` also works, and the choice is with the owner). They work on all three adapters and under `@nestjs/testing`, and sit outside the host's global prefix, versioning, guards, pipes and interceptors, but **not** outside the host's exception filters.
- **Host layers.** Host middleware, `helmet`, `compression`, `enableCors()` and `app.useSecurityHeaders()` apply to the dashboard routes on every adapter. The dashboard sets its own `Content-Security-Policy` and every header it relies on, on every response; a handler's `setHeader` replaces the host's value.
- **Shadowing.** A host catch-all route, or `@nestjs/serve-static`'s SPA fallback, can shadow the dashboard on Express, and on platform-node whenever a `use()` sits between the host's routes and ours. Fastify was not affected. Nest has no public route table. Detection, two candidates (spike P0-S5): a startup self-request to our own route after `listen$` (runs host middleware and possibly the host's catch-all once, misreports host 401/429 as shadowing, skipped when `listen` is never called), or passive detection on the first real visit from the request and route hooks Nestrix already installs. Chosen in phase 2.
- **Handlers.** Every dashboard handler first takes over the raw response (`reply.hijack()` when the reply has one, i.e. Fastify; then `res.raw ?? res`), removes every `Access-Control-*` header, and catches everything, answering errors itself with a 500 through the same path (rule 1). An exception that escapes would reach the host's global filters.
- **Assets.** The file list is known at build time. Each file is an exact route, served from memory with immutable cache headers, written to the raw response (`statusCode`, `setHeader`, `end(buffer)`). Not through `httpAdapter.reply`, which JSON-encodes a `Buffer` on Express, nor `httpAdapter.end`, which drops headers on Fastify (spike P0-S5). No static-file plugin, no `@fastify/static` peer; the one per-adapter step is the duck-typed `hijack()`.
- **Base path.** `index.html` is templated per request with `<base href>` and a JSON config block. Assets are built with relative URLs.
- **Hash routing.** No catch-all fallback route is needed.
- **Live updates** by polling with a cursor every one to two seconds while the tab is visible. Server-sent events are deferred.
- **Scope.** Each process shows only its own traces. Embedded mode is for development and single-instance deployments.

### 4.7 Dashboard security

The dashboard can expose URLs, SQL and stack traces, so it is closed unless something positive says otherwise.

- `ui: 'auto'` (the default) serves the dashboard only when all of these hold: `@nestrix/ui` is installed; `NODE_ENV` is `development` or unset; and, per request, the socket peer (`(req.raw ?? req).socket.remoteAddress`) is loopback (`127.0.0.0/8`, `::1`, `::ffff:127.0.0.0/104`), the raw `Host` header is present and names a loopback host, and none of `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`, `Via` is present. These are read from the raw socket and headers, never from `req.ip`, `req.hostname` or `getRequestHostname()`, which follow client-supplied forwarding headers when the host trusts proxies.
- **Limit of `ui: 'auto'`.** The checks cannot tell a local browser from a reverse proxy on the same host that adds no forwarding headers and rewrites `Host` to the upstream address, which is nginx's default for `proxy_pass http://127.0.0.1:<port>`. Such a deployment with `NODE_ENV` unset exposes the dashboard (spike P0-S5, run through a real proxy). The docs say so where `ui: 'auto'` is introduced. Whether `ui: 'auto'` also requires a startup token is open (owner).
- Anything else, including staging and production, needs `ui: { enabled: true, auth }`. `auth` is either the built-in token authenticator (`{ token }`, compared in constant time) or a custom `authorize(request)`. Enabled without `auth`, Nestrix logs an error and leaves the dashboard off; the app starts normally.
- `authorize` receives the raw, adapter-specific request **before** any Nest guard has run, so `request.user` is not populated. The docs say this where the option is introduced.
- The dashboard API rejects requests with `Sec-Fetch-Site: cross-site`, and its responses never carry CORS allow headers, whatever the host's CORS configuration is: handlers hijack and strip as above, on success and error paths. On Fastify they never answer through `reply.send()`, because `@fastify/cors` with `hook: 'preSerialization'` runs after the handler and re-adds them. What Nestrix does not control: preflight (`OPTIONS`) requests for dashboard paths are answered by the host's CORS layer with the host's allow headers. A cross-origin page can then send the request but not read the response. This is acceptable only while the API is read-only; a state-changing endpoint would need its own CSRF defence.
- Read-only. `X-Robots-Tag: noindex`. Its own Content-Security-Policy; all assets same-origin; nothing inline is executed.

### 4.8 Privacy defaults

- No request or response bodies. Headers by a short allowlist. Query-string values redacted by key.
- Redaction is applied where Nestrix sets attributes, and again inside the store processor for every span it stores, including spans from other instrumentations. When the host owns the SDK, Nestrix cannot redact what the host's exporters send; the docs say so.
- Key-based redaction cannot clean free text. Exception messages are stored as they are; a `redact(span)` hook lets the user rewrite or drop them.

### 4.9 Performance and reliability

- Export is batched and asynchronous through a bounded queue. On overflow, spans are dropped and counted. Nothing in a request path waits on the exporter.
- Buffered spans are flushed on shutdown, which needs `app.enableShutdownHooks()`; the docs recommend it.
- A `benchmarks/` workspace runs the same app under four configurations (uninstrumented, headless, with dashboard, upstream auto-instrumentation) and records p50/p99 latency, throughput, CPU, RSS and startup time, plus a run with the OTLP endpoint unreachable. `@nestjs/observe` is not benchmarked; its licence does not clearly permit it.
- Targets are set from the phase 1 baseline and enforced as CI thresholds. Starting hypotheses: level 1 at 100% sampling within 10% of uninstrumented throughput on a trivial route; under 100 ms added startup; RSS growth during an exporter outage bounded by the configured queue and store sizes plus a measured constant.

### 4.10 Standalone server (phase 5)

- One Docker image: a NestJS 12 app, instrumented with Nestrix itself, with an OTLP/HTTP receiver, storage, the query API and the same UI build.
- Receiver: `/v1/traces` first; protobuf and JSON; gzip; 64 MiB limit; partial success; 429/503 with `Retry-After`. Decoding with `@bufbuild/protobuf` and code generated from a pinned `opentelemetry-proto`, checked in. OTLP's JSON form gets its own mapping.
- Storage: PostgreSQL 18 with Drizzle. `spans` partitioned by day, `resources`, and a per-minute rollup per service and route written at ingest. Retention by dropping partitions. Partition DDL in hand-written SQL migrations. Start on Drizzle 0.45; move to 1.0 when it is stable.
- Scope is stated honestly: the supported ingest rate is measured and published. Beyond it, send OTLP to a dedicated backend.
- Ingest authenticated by API key; one admin login for the UI.

## 5. Packages

| Package | Contents |
|---|---|
| `@nestrix/nestjs` | The SDK: module, `NestrixInstrument`, Nest instrumentation, outbound HTTP, the `pg` / `mysql2` / `ioredis` integrations, OpenTelemetry setup, in-memory store, query API, redaction |
| `@nestrix/ui` | Prebuilt dashboard assets only. No runtime dependencies. Optional. Budget: under 1 MB unpacked, enforced in CI. |
| `@nestrix/server` (phase 5) | Standalone collector, storage and UI host. Distributed primarily as a Docker image. |
| `packages/protocol` (private) | Query-API types shared by the SDK, the server and the UI |

One version number for all. An integration becomes its own package only when it needs a heavy or conflicting dependency.

## 6. Frontend

React 19, Vite 8, TypeScript. TanStack Router with hash history; TanStack Query for polling; TanStack Virtual for long span lists. Tailwind 4 with shadcn/ui components copied into the repository. uPlot for time series (Chart.js as fallback). The trace waterfall is built in-house. A static SPA: no server rendering, no framework server. The standalone server serves the same build.

## 7. Developer experience

These APIs are illustrative until phase 1 settles the names; they freeze at 1.0.

```bash
pnpm add @nestrix/nestjs @nestrix/ui    # SDK plus dashboard assets
pnpm add @nestrix/nestjs                # headless only
```

```ts
// app.module.ts
import { NestrixModule } from '@nestrix/nestjs';

@Module({ imports: [NestrixModule.forRoot({ serviceName: 'my-api' })] })
export class AppModule {}
```

Locally the dashboard is then at `http://localhost:3000/_nestrix`, and spans are exported if `OTEL_EXPORTER_OTLP_ENDPOINT` is set. The standard `OTEL_*` variables are honoured. At startup Nestrix logs one line: the dashboard URL, or the command to install the assets.

```ts
// main.ts: level 2
import { NestrixInstrument } from '@nestrix/nestjs';

const app = await NestFactory.create(AppModule, { instrument: NestrixInstrument });
app.enableShutdownHooks();
```

```ts
NestrixModule.forRoot({
  serviceName: 'my-api',
  sampleRate: 0.1,
  export: { otlp: { endpoint: 'http://otel-collector:4318' } },
  ui: { enabled: true, path: '/_nestrix', auth: { token: process.env.NESTRIX_UI_TOKEN } },
  ignore: { routes: ['/health', '/metrics'] },
  integrations: { ioredis: false },
});
```

```ts
// BullMQ jobs, with BullMQ's own option
import { BullMQOtel } from 'bullmq-otel';

BullModule.forRoot({ connection, telemetry: new BullMQOtel('my-api') });
```

```ts
import { Span, withSpan } from '@nestrix/nestjs';

@Span('billing.reconcile')
async reconcile() { /* … */ }

await withSpan('load-rates', () => fetchRates());
```

`Span` and `withSpan` are thin wrappers over `@opentelemetry/api`. Code that uses the OpenTelemetry API directly joins the same traces.

## 8. Repository

```
nestrix/
  packages/nestjs/        @nestrix/nestjs
  packages/ui/            @nestrix/ui (dashboard source; publishes dist/ only)
  packages/protocol/      private: query-API types
  apps/server/            phase 5
  examples/               express-esm, fastify-esm, node-esm, express-cjs, microservices
  benchmarks/
  docs/
```

- pnpm workspaces. No Turborepo until CI time justifies it.
- TypeScript 6, `module` and `moduleResolution: nodenext`, legacy decorators with `emitDecoratorMetadata`. The SDK is built with `tsc` only.
- ESM-only output. No top-level `await` in any published entry point, so CommonJS Nest 12 apps can `require()` it. Enforced by `pnpm check:tla` (`scripts/check-no-tla.mjs`, part of `verify`, so it runs on every Node in the CI matrix): it `require()`s each published entry and every built file in a child process. Users of CommonJS projects running Jest need `--experimental-vm-modules` (Nest's own CommonJS starter sets it) and Node 24.9+, or a transform on 22.x; this is how Nest 12 itself loads under Jest.
- Vitest 4. Integration tests boot real Nest apps on all three adapters and assert on spans captured by an in-memory exporter.
- Biome for lint and format. `publint` and `@arethetypeswrong/cli` in CI.
- Changesets with fixed versioning. Publishing from GitHub Actions through npm trusted publishing with provenance.
- CI matrix: Node 22.15, 24, 26 × Nest 12.0 and latest × Express and Fastify, plus platform-node from 12.3.

## 9. Main risks

| Risk | Mitigation |
|---|---|
| The Nest team's product is in the default starter and they control the hooks. | Compete on what its licence and hosting rule out. Use only public, documented hooks. |
| Nest's hooks are single-slot and recent; behaviour may shift in minors. | A conformance suite against the minimum and latest Nest 12, with a nightly run against `latest`. |
| An embedded dashboard exposes application internals. | Local-only default, fail-closed without `auth`, no CORS, read-only, redaction before storage. |
| Method wrapping changes behaviour (lost metadata, private fields, callable objects). | The requirements in §4.3, a spike before building, and a test corpus of awkward classes. |
| Postgres cannot keep up with a busy fleet. | Publish the measured envelope; recommend a dedicated backend beyond it. |
| OpenTelemetry JS moves fast (SDK 2.0 to 3.0 in about 18 months). | Depend on few SDK packages, pin one SDK generation per minor line, keep instrumentation on the stable API only. |
| Upstream ships Nest 12 support and narrows the gap. | The value does not rest on that gap: no loader flags, deeper Nest coverage, and the dashboard remain. |
| Scope. | Vertical slices; standalone and logs/metrics come after the SDK has users. |
