# Roadmap

Each phase is a vertical slice that ends with something a user can run. A phase is done when its acceptance criteria pass in CI, not when the code is written. At the end of every phase, work stops for the owner's review before the next phase starts.

Current phase: **3, in progress** (task list [backlog/phase-3.md](backlog/phase-3.md)); **phase 4 runs in parallel** ([backlog/phase-4.md](backlog/phase-4.md)), since it depends only on phase 1. Phase 2 is complete and approved by the owner on 2026-11-11 (task list [backlog/phase-2.md](backlog/phase-2.md), report [phase-2-report.md](phase-2-report.md)). Phase 1 is complete and approved by the owner on 2026-11-11 (task list [backlog/phase-1.md](backlog/phase-1.md), report [phase-1-report.md](phase-1-report.md)). Phase 0 is complete (task list [backlog/phase-0.md](backlog/phase-0.md), report [phase-0-report.md](phase-0-report.md), gate decisions D-40 to D-51 in [decisions.md](decisions.md)). Later phases get their task list written when they start, by whoever leads the work, from the deliverables below.

## Phase 0: foundations and spikes

**Objective.** Stand up the workspace and remove the technical unknowns before anything is built on them.

**Deliverables**
- Workspace toolchain, package skeletons, CI, and the example apps (Express ESM, Fastify ESM, platform-node ESM, Express CommonJS).
- A test harness: boot a Nest app on any adapter and capture its spans in memory.
- Six time-boxed spikes, each ending in a written result in `docs/spikes/`:
  1. HTTP adapter hooks.
  2. Library spans without a preload flag.
  3. Coexistence with a host-registered OpenTelemetry SDK, and with `@sentry/nestjs`.
  4. Loading the ESM-only package from a CommonJS Nest 12 app.
  5. Dashboard mounting.
  6. Instance-decorator method wrapping.

**Depends on.** Nothing for local work. Publishing depends on the owner actions in [decisions.md](decisions.md).

**Acceptance**
- Every spike has a pass or fail per question, a chosen approach, and the resulting edits to `architecture.md`, `nest-hooks.md` and `research.md`.
- CI is green on the Node matrix.
- The packed tarballs install into a fresh ESM app and a fresh CommonJS app, and both boot.

**Validation.** The spikes' checks are kept as tests where they can be, so later Nest releases re-run them.

## Phase 1: headless tracing (0.1.0-alpha)

**Objective.** A Nest 12 app with one module import sends correct traces to any OTLP backend.

**Deliverables.** `NestrixModule.forRoot` / `forRootAsync`; HTTP server spans; handler exceptions; outbound HTTP spans and propagation through first-party fetch/undici and `node:http` subscribers (D-42; no `instrumentation-undici`); OTLP/HTTP export, with `@opentelemetry/context-async-hooks` and `@opentelemetry/core` for the context manager and propagator (D-41); sampling; bounded queue; privacy defaults and the redaction hook; shutdown flush; `Span` and `withSpan`; a `docker compose` example with Jaeger; first benchmark baseline. Supported versions as in D-44 (`@nestjs/platform-node` from 12.3.2; Express and Fastify from 12.0.0) and SDK 3 only (D-40), with the `ERESOLVE` for SDK 2 hosts explained in the docs. Sentry coexistence documented (D-43): two traces with Sentry's defaults, the one-trace option and its costs, and no tracing of Sentry's envelope requests.

**Depends on.** Spikes 1, 2 (its outbound-HTTP part), 3 and 4.

**Acceptance**
- A request through two example services appears in Jaeger as one trace with correct parent and child links and route names.
- The conformance suite below passes on Express, Fastify and platform-node.
- With the OTLP endpoint unreachable for a ten-minute load run, RSS levels off: growth after the first minute stays within a bound derived from the configured queue size, and p99 latency stays within 5% of the run with the endpoint reachable.
- Install size and startup cost are measured and written into the README.

**Conformance suite: expected results**

Attribute names follow the OpenTelemetry HTTP semantic conventions current at implementation time; settle exact names then.

| Case | Expected server span |
|---|---|
| Matched route, 200 | Named `METHOD /route/:template`; route attribute set; status unset |
| Unmatched request, 404 | Named by method only; no route attribute; status unset |
| Guard rejects, 403 | Named with the route template; status unset; no exception at level 1 |
| Handler throws an `HttpException` below 500 | Exception recorded as an event; status unset |
| Handler throws anything else, 500 | Exception recorded; status error |
| Exception filter turns an error into a 200 | Exception recorded; status unset |
| Streamed response | Ends when the stream closes; duration covers the stream |
| Client aborts mid-response | Ends on close; marked as aborted |
| POST with a JSON body | A span created in the handler is a child of the server span |
| Multipart upload | Same |
| Header versioning, two versions of one route | Route attribute is the one that handled the request |
| Global prefix and URI versioning | Route attribute includes both |
| Nestrix's own hook throws (injected fault) | The request succeeds; the fault is counted |
| App bootstrapped through `@nestjs/testing` | Spans are produced; route template present for requests that reach a handler |
| `createMicroservice` and `createApplicationContext` apps | Nestrix starts without an HTTP adapter and does nothing HTTP-related |

**Validation.** Integration tests with an in-memory exporter; the benchmark workspace; the Jaeger example run in CI.

## Phase 2: embedded dashboard (0.1.0)

**Objective.** The same app shows its own traces at `/_nestrix` with nothing else running.

**Deliverables.** In-memory store; pre-sampling route counters; query API v1 and its types in `packages/protocol`; `@nestrix/ui` with request list, trace waterfall, error list, per-route latency and error rate, live updates; mounting on all three adapters under a configurable path; the security model of architecture §4.7, including the startup token for `ui: 'auto'` (D-46): a logged link with a random token that sets an HttpOnly cookie, and an explicit opt-out. Dashboard routes are registered in `onModuleInit` (D-45).

**Depends on.** Phase 1; spike 5.

**Acceptance**
- The dashboard works in the Express, Fastify and platform-node example apps, with and without a global prefix, with `app.useSecurityHeaders()`, and with host CORS enabled.
- A request from a non-loopback address, or with a forwarding header, or with `Sec-Fetch-Site: cross-site`, gets no dashboard data in the default mode.
- In `ui: 'auto'`, a request without the startup token cookie gets no dashboard data, including a loopback request through a same-host reverse proxy that adds no forwarding headers; opening the logged link sets the cookie and the dashboard then loads; the opt-out disables the check (D-46).
- With `NODE_ENV=production` and no `auth`, the dashboard is unreachable and the app starts.
- With a host catch-all route on Express, Nestrix reports that the dashboard is shadowed.
- At a sample rate of 0.1, per-route request counts match the number of requests sent, and the UI shows that lists are sampled.
- `@nestrix/ui` is within its unpacked-size budget, checked in CI: 1 MB as the target, or the measured size plus 20% (at most 2 MB) if the first build needs more (D-52).
- A Playwright test opens a trace and checks the waterfall rows.

**Validation.** Playwright against the example apps in CI; a security test file with one test per rule in §4.7.

## Phase 3: providers, data and jobs (0.2)

**Objective.** A trace explains where the time went inside the request.

**Deliverables.** `NestrixInstrument` and `composeInstrument`; method spans by default for the app's own controllers, services, repositories, queue processors and scheduled methods, with guard, pipe, interceptor and filter spans opt in (D-57, superseding D-47's default set); level 2 not applied under `@nestjs/testing`, documented (D-48); the `pg` integration on when present, wrapping nested copies already loaded (D-50), and opt-in `mysql2` and `ioredis` integrations that document the errors they then swallow (D-49); documented BullMQ setup and job views; scheduled jobs; slow-query highlighting and repeated-query grouping in the UI. Added by D-56: users on requests (opt-in), releases (`service.version`) and filtering by release, a map of the app and what it calls, and a classes view (total and own time, calls and errors per class and method, counted before sampling).

**First task.** Verify in a Nest app the timing of the `pg` `require.cache` scan (at enable and at `onApplicationBootstrap`), and settle the pool-wait rule (proposed: database spans cover the query only) (D-50).

**Depends on.** Spikes 2 and 6; phase 2.

**Acceptance**
- A request that runs three queries and enqueues a job shows all of them under the right parent; the job's processing appears as a linked trace.
- A route with a method-level guard still returns 403 with `NestrixInstrument` on, on all three adapters.
- Classes with `#private` members, request-scoped providers, providers holding callable objects, and plain function middleware behave exactly as without instrumentation.
- Benchmark deltas for level 2 at sample rates 1 and 0.1 are published.

**Validation.** A corpus of awkward classes as a test fixture; integration tests against real Postgres, MySQL and Redis containers.

## Phase 4: microservices (0.3)

**Objective.** One trace across Nest services over Nest's own transports.

**Deliverables.** A short spike first: metadata extraction per transport, handler coverage in hybrid apps, client span timing. Then handler spans for `@MessagePattern` and `@EventPattern`; context injection through `setOnDispatchHook`; client spans by wrapping `send` / `emit`; a helper for clients created outside dependency injection.

**Depends on.** Phase 1. `@nestjs/microservices` 12.0.4+.

**Acceptance.** End-to-end tests over TCP, Redis, NATS, Kafka and RabbitMQ, with containers in CI, each produce a single connected trace. MQTT 5 and gRPC are tested if time allows and otherwise documented as untested.

**Validation.** The end-to-end tests; a hybrid-app fixture.

## Phase 5: standalone server (0.4)

**Objective.** Several services send to one self-hosted Nestrix.

**Deliverables.** `apps/server`: OTLP/HTTP receiver, Postgres storage through Drizzle, retention, API-key ingest, admin login, the same UI build; a Docker image and a `docker compose` file. Added by D-56: a map across services.

**Depends on.** Phases 1 and 2; the query API being stable.

**Acceptance**
- `docker compose up` plus one environment variable in each example app gives a cross-service trace in the standalone UI.
- An ingest benchmark establishes the sustained spans per second the default Postgres setup handles; that number is published as the supported envelope.
- Retention drops partitions older than the configured age.

**Validation.** Receiver tests with recorded OTLP payloads (protobuf and JSON, gzip, partial success); the ingest benchmark.

## Phase 6: logs, metrics and 1.0

**Objective.** Round out the signals and freeze the API.

**Deliverables.** Log correlation (trace and span ids in Nest logger output) and optional OTLP log export; request-duration and runtime metrics exported over OTLP; a documentation site; an API review; 1.0.

**Depends on.** Phases 1 to 5.

**Acceptance.** A documented upgrade path from 0.x; the compatibility matrix published; no open issue labelled as a 1.0 blocker.

**Validation.** The full matrix in CI; the examples run as smoke tests against the release candidate.

## Phase 7: profiler, alerting and SLOs

**Objective.** Find where CPU time goes, and be told when something breaks (D-56).

**Deliverables.** A spike first on profiling a running Nest app without changing its behaviour or slowing it noticeably (likely on demand: "profile for 30 seconds"); then the profiler view. Alerting rules on route and class statistics (error rate, latency) with notifications (webhook first). SLOs over stored history. Alerting and SLOs run in the standalone server.

**Depends on.** Phase 5 (stored history); the profiler spike.

**Acceptance and validation.** Written when the phase starts, from the spike result.
