# Phase 1 backlog: headless tracing (0.1.0-alpha)

Objective, deliverables and acceptance: [roadmap.md](../roadmap.md#phase-1-headless-tracing-010-alpha). How to run this backlog: [ai/orchestration.md](../ai/orchestration.md). The design is in [architecture.md](../architecture.md) §4.2, §4.5, §4.8 and §4.9 and in [nest-hooks.md](../nest-hooks.md) §1 and §2. The spike results under `docs/spikes/` hold the evidence, and their code under `spikes/` is the reference for each mechanism.

## Status

Update this table as work moves. One line of notes at most; detail goes in the task's section.

| ID | Task | Tier | Depends on | Status | Notes |
|---|---|---|---|---|---|
| P1-00 | Backlog, public option types | lead | — | done | This file; `packages/nestjs/src/options.ts`. |
| P1-01 | Runtime dependencies | haiku | P1-00 | done | Done by the lead: sdk-trace, resources, core, context-async-hooks 3.1.1; exporter-trace-otlp-http 0.301.1; semconv 1.45.0. `pnpm verify` passes. |
| P1-02 | Module, option resolution, internal diagnostics | sonnet | P1-01 | done | 57 tests; forRootAsync factory resolved before NestrixCore; `enabled:false` from an async factory leaves inert providers. |
| P1-03 | OpenTelemetry setup and export pipeline | opus | P1-01 | review | 31 tests; wired into NestrixCore with `scrubSpanAttributes`; independent review running. |
| P1-04 | Privacy helpers | sonnet | P1-00 | done | 61 tests; reviewed (no leaks found), test gaps, speed and `//authority` hardening fixed. A target starting with `//` loses its first segment in `splitUrl`. |
| P1-05 | `Span` and `withSpan` | sonnet | P1-01 | done | 40 tests; reviewed, 3 fixes applied; fire-and-forget promise case accepted and documented in architecture §4.3. |
| P1-06 | HTTP server spans | opus | P1-02, P1-03, P1-04 | doing | review required |
| P1-07 | Handler attribution and exceptions | opus | P1-06 | todo | review required; same agent as P1-06 |
| P1-08 | Outbound `node:http` spans and the shared outbound rules | opus | P1-02, P1-03, P1-04 | doing | review required |
| P1-09 | Outbound fetch/undici spans | opus | P1-08 | todo | review required; same agent as P1-08 |
| P1-10 | Conformance suite | sonnet | P1-07, P1-09 | todo | |
| P1-11 | CI matrix and nightly | sonnet | P1-10 | todo | |
| P1-12 | Jaeger example, two services | sonnet | P1-09 | doing | Example, compose (jaeger 2.23.0) and check script merged; export to Jaeger verified; the trace assertion runs after P1-06/09 merge. |
| P1-13 | Benchmarks: baseline, exporter outage, install size, startup | sonnet | P1-09 | doing | |
| P1-14 | CommonJS decorated-class check | haiku | P1-02 | done | Consume fixtures boot `forRoot` and read the injected options in CJS (Node 22.15, 26) and ESM apps. |
| P1-15 | User documentation | sonnet | P1-07, P1-09, P1-13 | todo | |
| P1-16 | Phase report | lead | all | todo | |

Statuses: `todo`, `doing`, `review`, `done`, `blocked` (say on what).

Order: P1-01 first. Then P1-02, P1-03, P1-04 and P1-05 in parallel (disjoint files). Then P1-06/07 and P1-08/09 in parallel, two agents. Then P1-10 to P1-15, mostly in parallel. P1-16 last.

## Rules for every task

- The rules in `AGENTS.md` apply, and the "Rules for every hook and subscriber" in architecture §4.2 apply to every hook, subscriber, wrapper, interceptor and processor method. They are not repeated here, but a brief that touches the request path names them.
- Resolve versions live (`npm view <pkg> version`). pnpm's release-age gate is strict (D-51): if an install fails on it, report it; do not add exclusions.
- Instrumentation imports `@opentelemetry/api` only. SDK packages are imported only under `src/otel/`.
- No `instanceof` on OpenTelemetry classes (architecture §4.5). Tracers are obtained at use time.
- Every file under `packages/nestjs/src/` owns one concern; the file ownership in each task below keeps parallel agents apart. `src/index.ts` (the public exports) is edited only by the lead when merging.
- Tests live in `packages/nestjs/test/`. Tests that need the OpenTelemetry globals in a particular state (no provider, a host provider) run in their own file: Vitest isolates files, not tests. `@nestrix/testing`'s `bootApp` registers a host provider with an in-memory exporter, which exercises the host-SDK path; the Nestrix-owned path needs its own files.
- A change to `@nestrix/nestjs` comes with a changeset (P1-02 adds the first one; later tasks extend it or add their own).
- A task is `done` when its checks have been run and their output read, `pnpm verify` passes, and, where the table says so, an independent `reviewer` has passed it and its findings are resolved.

## Public API

Settled here so parallel tasks agree. `architecture.md` §7 is updated to match in P1-15.

```ts
// Module
NestrixModule.forRoot(options?: NestrixModuleOptions): DynamicModule
NestrixModule.forRootAsync({ imports?, inject?, useFactory }): DynamicModule   // useFactory may be async

// Custom spans
Span(name?: string, options?: SpanOptions): MethodDecorator   // default name `Class.method`
withSpan<T>(name: string, fn: (span: api.Span) => T, options?: SpanOptions): T  // T may be a promise
```

`NestrixModuleOptions` and its parts are in `packages/nestjs/src/options.ts`. The module is global. `ui` and `integrations` are not accepted yet (phases 2 and 3).

**Export default.** OTLP export is on when an endpoint is set by option or environment, and off otherwise (one log line says so). With the host owning the SDK, export and sampling options are ignored and one log line says so.

**Attributes.** OpenTelemetry HTTP semantic conventions, stable names, from the `@opentelemetry/semantic-conventions` version resolved in P1-01, imported from its stable entry point only (incubating names, if any are needed, as string literals). Nestrix's own attributes use the `nestrix.` prefix:

| Attribute | Where | Meaning |
|---|---|---|
| `code.function.name` | server span | `Controller.handler`, set by the interceptor |
| `nestrix.http.aborted` | server span | `true` when the client went away before the response finished |
| `nestrix.http.body` | client span | `"not consumed"` when the span ended at the response head because nothing read the body (§4.2) |

Server span name: `METHOD /route/template`, or `METHOD` when there is no route. Client span name: `METHOD`.

**Privacy defaults.** Recorded request headers: `content-type`, `content-length`, `x-request-id`; response headers: `content-type`, `content-length`. `user-agent` goes to `user_agent.original`. `authorization`, `proxy-authorization`, `cookie` and `set-cookie` are recorded as `REDACTED` even when listed. Query values replaced by `REDACTED` for these keys, case-insensitive: the semantic conventions' `AWSAccessKeyId`, `Signature`, `sig`, `X-Goog-Signature`, plus `token`, `access_token`, `refresh_token`, `id_token`, `api_key`, `apikey`, `key`, `password`, `passwd`, `secret`, `client_secret`, `code`, `session`, `sessionid`, `jwt`, `auth`, `authorization`. User options add to these lists; they do not replace them.

## Tasks

### P1-01 Runtime dependencies

**Do.** Add to `packages/nestjs` as runtime `dependencies`, each at the latest version compatible with SDK 3 and the `@opentelemetry/api` peer range already declared (`>=1.10.0 <1.11.0`): `@opentelemetry/sdk-trace`, `@opentelemetry/resources`, `@opentelemetry/core`, `@opentelemetry/context-async-hooks`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/semantic-conventions`. Nothing else: this is the budget of architecture §4.5 and D-41. Check each one's `peerDependencies` against the api range and report any mismatch instead of resolving it.

**Done when.** `pnpm install` succeeds without new release-age exclusions; `pnpm verify` passes; the report lists each package, its version, its peer range on `@opentelemetry/api`, and `npm view <pkg> dependencies` for the exporter (its transitive weight matters for P1-13).

### P1-02 Module, option resolution, internal diagnostics

**Owns.** `src/nestrix.module.ts`, `src/resolve-options.ts`, `src/diagnostics.ts`, `src/tokens.ts`, `.changeset/*`.

**Do.**
- `NestrixModule.forRoot` and `forRootAsync` per "Public API", global, providing the resolved options under an injection token. `forRootAsync` resolves its factory before any Nestrix provider is constructed (Nest does this for an async factory provider that is a constructor dependency; verify with a test).
- `resolveOptions(options, env)`: a pure function from `NestrixModuleOptions` and an environment object to a fully defaulted, frozen `ResolvedOptions`. Defaults and environment variables as documented in `options.ts`. Validates: `sampleRate` in [0, 1], queue sizes positive integers, `maxExportBatchSize <= maxQueueSize`. Invalid options are an error at module creation: a typo in configuration should fail loudly at startup, which is not a request-path failure. `enabled: false` or `NESTRIX_ENABLED=false` makes `forRoot` return a module with no providers at all.
- `diagnostics.ts`: Nestrix's internal logger and failure counter. `logOnce(key, message)` writes through Nest's `Logger` with context `Nestrix` once per key per process; `countFailure(where, error)` increments a per-site counter and logs the first error of each site once. Both never throw. Exposed to tests through an internal function, not the public API.
- A module-level `NestrixCore` provider whose constructor is where later tasks hook in (P1-03 registers telemetry from it; P1-06 installs HTTP hooks from it). Leave clearly marked call sites; do not implement them.
- The first changeset: minor bump of `@nestrix/nestjs` and `@nestrix/ui` ("Headless tracing").

**Do not.** Register any OpenTelemetry global; set any adapter hook; read `process.env` anywhere but the module factory.

**Done when.** Unit tests for `resolveOptions` (defaults, each env variable, precedence, every validation error); a test booting the fixture app with `forRoot()` and with `forRootAsync({ useFactory: async () => … })` that injects the resolved options; a test that `enabled: false` adds no providers; `pnpm verify` passes.

### P1-03 OpenTelemetry setup and export pipeline

**Owns.** `src/otel/**`.

**Do.** `setupTelemetry(resolved, diagnostics)`, called from the `NestrixCore` constructor (never at import or `forRoot()` time, architecture §4.2 "Registration timing"), returning a handle with `ownsProvider`, `shutdown()` and the counters.
- Provider ownership per architecture §4.5: try `trace.setGlobalTracerProvider`; on `false` the host owns it, Nestrix builds nothing more and logs once. Settle the open detail there (§4.5 "Whether the provider check accepts that one diag error"): either accept the single diag line, or probe first. Record the choice in architecture.md.
- A provider that loses the race is never built with a processor the host uses, and is shut down (§4.5).
- When Nestrix owns the provider: probe for a context manager and a propagator (§4.5) and register the ALS manager and W3C propagator (`@opentelemetry/context-async-hooks`, `@opentelemetry/core`) only where none exists. Sampler `ParentBased(TraceIdRatioBased(sampleRate))`. Resource from `serviceName`, `resourceAttributes` and `OTEL_RESOURCE_ATTRIBUTES` (check whether SDK 3 still reads that variable itself; say what you found).
- Export: `BatchSpanProcessor` with the OTLP/HTTP exporter, queue options from `resolved.export.queue`. Count dropped spans (the batch processor drops on a full queue; find a way to count that is not a private field, or report that there is none). With the endpoint unreachable, memory must stay bounded: check the exporter's own retry and concurrency limits and what they hold, because the P1-13 outage acceptance rides on it.
- The `redact` hook and Nestrix's store-independent redaction step run for every span the owned pipeline exports, before the exporter sees it. `ReadableSpan` is read-only in `onEnd`: find out whether SDK 3's `SpanProcessor` has a hook where the span is still mutable (`onEnding`), or wrap the exporter. A throwing hook drops the span and counts the failure. Every processor method catches everything; `forceFlush` and `shutdown` never reject (§4.5).
- Shutdown: `onApplicationShutdown` flushes and shuts down the owned provider, bounded by a timeout. Never touches a host provider. Document that it needs `app.enableShutdownHooks()`.
- Another hook-based APM (D-33): detect what can be detected through public API at bootstrap (for example `getOnRouteTriggered()` already returning a function that is not Nestrix's) and log a warning. Say what cannot be detected.

**Do not.** Use `instanceof` on OTel classes; import SDK packages outside `src/otel/`; add a dependency.

**Done when.** Tests, each in its own file where globals matter: Nestrix owns the provider and exports to a local OTLP receiver stub (a plain `node:http` server counting `/v1/traces` posts); host provider registered first (Nestrix builds nothing, host gets the spans); host context manager present (Nestrix does not replace it); `sampleRate: 0` exports nothing; a throwing `redact` drops the span and the app keeps serving; shutdown flushes buffered spans; an unreachable endpoint with a small queue counts drops. Reviewer pass.

### P1-04 Privacy helpers

**Owns.** `src/privacy.ts`.

**Do.** Pure functions, used by P1-06, P1-08 and P1-09: build the header allowlist from defaults plus options; pick and normalise allowlisted headers from a Node `IncomingHttpHeaders` or an undici header array into attributes (multi-valued headers as string arrays, per the conventions); redact query values by key in a raw query string, preserving order and keys and replacing values with `REDACTED`; split a URL or path into `url.path` and the redacted `url.query`. Defaults as in "Public API". Malformed input (bad percent-encoding, repeated keys, keys without `=`) never throws and never leaks an unredacted value: when in doubt, redact.

**Done when.** Unit tests covering each default key, case-insensitivity, repeated and encoded keys (`api%5Fkey`), empty values, fragments, the always-redacted headers, and a property-style test that no value of a listed key survives in the output. Reviewer pass.

### P1-05 `Span` and `withSpan`

**Owns.** `src/span.ts`.

**Do.** Per "Public API". `withSpan` starts an active span, ends it when `fn` returns or, for a native promise, settles; records an exception and sets error status on throw or rejection, then rethrows the original. `Span` replaces `descriptor.value` with a wrapper that does the same, and copies every reflect-metadata key, own property, `name` and `length` from the original (rule 3: `@Span` stacked with `@Get`, `@UseGuards` or `@SetMetadata` in either order must leave Nest's behaviour unchanged). Promise handling as architecture §4.3: only a plain native promise is followed. If the tracer itself throws, the user's function still runs exactly once.

**Done when.** Tests: span parented to the active span; error recording; rethrow preserves identity; a controller method with `@Span` above and below `@Get` and `@UseGuards` still routes and still rejects; `this` preserved; sync and async; a `fn` that throws synchronously is called once. Reviewer pass.

### P1-06 HTTP server spans

**Owns.** `src/http/server.ts`, `src/http/request-state.ts`, and the hook call site in `NestrixCore`.

**Do.** Architecture §4.2 "HTTP server span" and nest-hooks.md §1 and §2, all of it:
- Install `setOnRequestHook` and `setOnRouteTriggered` from the `NestrixCore` constructor, or from a guarded `HttpAdapterHost.init$` subscription when the adapter is not yet set. Nothing HTTP-related when there is no adapter (`createMicroservice`, `createApplicationContext`).
- Per-request state under a context key Nestrix owns: the server span, the route, and whether the interceptor ran (set by P1-07). The route hook finds the span through that key, never `trace.getActiveSpan()`. Chain the previous route callback.
- End on the raw response's `close`, with the outcome rule (status code only when headers were sent; `nestrix.http.aborted` per §4.2). Before Node 24.20 the `writableFinished` signal for a cut after the app ended is unreliable (§4.2 caveat): find a signal that works on 22.15 and 24.x (candidate: `socket.destroyed` at `close`, verify it does not misfire on keep-alive or normal completion), or document the limit; test on 22.15 and 26.
- `splitUrl` (P1-04) treats a target starting with `//` as an authority and drops its first segment; for the server's `url.path`, pass the origin-form target in a way that keeps it, or accept and document it.
- 404 rule: no route when the request matched none, and when the final status is 404 and the interceptor never ran (header, media-type and custom versioning, host filters; the rule is a design inference: test it on all three adapters).
- `ignore.routes`, request and response header allowlists and query redaction through P1-04, attributes per "Public API".
- A fault anywhere in Nestrix's hook: the request still succeeds, `done()` is called exactly once, the fault is counted. Provide an internal fault-injection seam for P1-10 that is not part of the public API.

**Done when.** Tests on Express, Fastify and platform-node through `bootApp`, and under `@nestjs/testing`: route names with prefix and URI versioning; 404 naming; abort marking; stream duration; injected fault; `createMicroservice` and `createApplicationContext` boot with Nestrix and install nothing. Reviewer pass.

### P1-07 Handler attribution and exceptions

**Owns.** `src/http/interceptor.ts`, `src/process-errors.ts`.

**Do.**
- A global interceptor provided by the module (`APP_INTERCEPTOR`) that sets `code.function.name`, marks the request state as reached, and records exceptions thrown by handlers and pipes per the conformance table in the roadmap (an `HttpException` below 500 is an event with status unset; anything else sets error; an error a filter turns into a 200 is still recorded, status unset). Error status is decided at `close` from the final status code plus what the interceptor saw, not in the interceptor alone. It rethrows the original error untouched and never changes the observable stream.
- Process-level errors: architecture §4.2 says `uncaughtExceptionMonitor` and `unhandledRejection` listeners record errors "without changing behaviour". That is wrong for `unhandledRejection`: under Node's default `--unhandled-rejections=throw`, adding any listener stops the process from crashing. Use `uncaughtExceptionMonitor` only (it also sees unhandled rejections that become uncaught exceptions, with `origin`), confirm that with a test, record best effort, and correct §4.2. Add no `uncaughtException` or `unhandledRejection` listener.

**Done when.** Tests for every exception row of the conformance table on all three adapters; a test that an unhandled rejection still terminates a child process with Nestrix loaded; reviewer pass.

### P1-08 Outbound `node:http` spans and the shared outbound rules

**Owns.** `src/outbound/rules.ts`, `src/outbound/node-http.ts`.

**Do.** Port the P0-S2 mechanism (`spikes/p0-s2`, architecture §4.2 "Outbound HTTP"): span from `http.client.request.created` with the caller's context; `traceparent` injected through the registered propagator only when absent, tolerating a `setHeader` throw; end on the response's `close` or on `request.error`; the unread-body fallback. `rules.ts` holds what P1-09 reuses: the suppress-tracing key, no span without an active parent, `ignore.outgoing`, header and URL privacy through P1-04. Subscribe when telemetry is set up; unsubscribe on shutdown.

**Done when.** Tests: child span and header for `GET /out` through `http.get`; existing `traceparent` kept; array headers; no span outside a request; suppressed context; ignore list; body read, unread, aborted mid-body; Nestrix's own exporter requests produce no spans. Reviewer pass.

### P1-09 Outbound fetch/undici spans

**Owns.** `src/outbound/undici.ts`.

**Do.** First-party subscriber on undici's diagnostics channels (D-42). Establish which channels Node 22.15, 24 and 26 publish for the global `fetch` and for the `undici` package (they can be different copies of undici: check both), how to add a header from `undici:request:create`, and when a request ends when the caller never reads the body. Same rules as P1-08 through `rules.ts`.

**Done when.** Tests on every Node in the matrix (the CI matrix runs them; run at least 22.15 and 26 locally): global `fetch` and `undici.request` give a child span and send `traceparent`; unread body; error; abort; the P1-08 rule cases. Record the channel facts in research.md. Reviewer pass.

### P1-10 Conformance suite

**Do.** One test file per adapter (or one parametrised file) that runs every row of the roadmap's conformance table against the fixture app and asserts exactly the expected server span. Settle the semconv attribute names in the table's assertions from what P1-06/07 emit. The multipart and JSON-body cases assert that a span created in the handler (through `withSpan`) is a child of the server span. Include the injected-fault row through P1-06's seam.

**Done when.** The suite passes on Express, Fastify and platform-node, on Nest 12.0.0 (Express, Fastify), 12.3.2 (platform-node) and the latest 12.x. How to install old Nest versions side by side: follow `spikes/p0-s1-nest12-0`.

### P1-11 CI matrix and nightly

**Do.** Extend `.github/workflows/ci.yml` to the matrix in architecture §8 (Node 22.15, 24, 26 × Nest 12.0 and latest × Express and Fastify, plus platform-node from 12.3.2), keeping the minutes budget in mind (2,000 a month while private: run the full matrix on `main` and pull requests only, and the old-Nest cells on one Node version if that keeps a run under ~15 minutes). Add to the nightly workflow: the conformance suite on the latest Nest 12.x, including the `@nestjs/testing` `http.route` assertion (§4.2). Use the `github-actions` skill's rules.

**Done when.** actionlint passes and every job passes under `act` (commands in `AGENTS.md`).

### P1-12 Jaeger example, two services

**Do.** `examples/jaeger/`: two small Nest apps (service A calls service B with `fetch`), both with `NestrixModule.forRoot()`, and a `docker compose` file with Jaeger all-in-one (current image tag, from the registry). A script that starts everything, sends one request to A, and queries Jaeger's HTTP API until it finds one trace with A's server span, A's client span and B's server span correctly parented and both route names set. A CI job runs it.

**Done when.** The script passes locally and under `act`.

### P1-13 Benchmarks

**Do.** The `benchmarks/` workspace from architecture §4.9, minus the dashboard configuration (phase 2): the fixture app uninstrumented, headless with a local OTLP sink, and headless with the endpoint unreachable. Upstream auto-instrumentation as a fourth configuration if it runs on Nest 12 with its documented loader flags; if it does not, say so in the results. Record p50/p99 latency, throughput, CPU, RSS and startup time. The outage run: ten minutes under load, RSS sampled every few seconds; it passes when RSS growth after the first minute stays within a bound derived from the configured queue size (derive and state it) and p99 is within 5% of the reachable run. Measure install size (`du` of a fresh install of the packed tarball with production dependencies) and added startup time.

**Done when.** `pnpm --filter benchmarks run` produces a results file; the outage criterion is evaluated and reported with its numbers; install size and startup cost are in the report for P1-15.

### P1-14 CommonJS decorated-class check

**Do.** P0-S4 left this open: in the CommonJS consume fixture (`.github/ci-fixtures/`), import `NestrixModule` from the packed tarball, boot an app with `forRoot()`, and assert that Nestrix's providers were constructed with their dependencies (so `design:paramtypes` survived the ESM/CJS boundary).

**Done when.** The consume job passes under `act` for CJS on Node 22.15 and 26.

### P1-15 User documentation

**Do.** `packages/nestjs/README.md` (the npm page) and the root README: install, `forRoot`, `forRootAsync`, every option, `OTEL_*` variables honoured, export default, `enableShutdownHooks`, `Span`/`withSpan`, privacy defaults and the `redact` hook (and that it does not apply to a host-owned SDK), supported versions (D-44), SDK 3 only with the `ERESOLVE` explained (D-40), Sentry coexistence (D-43: two traces with defaults, the one-trace option and its costs), one hook-based APM per process (D-33), the CommonJS caveats (Jest, upstream instrumentations constructed before Nestrix registers, §4.1 level 4), and install size and startup cost from P1-13. Update architecture.md §7 to the settled API.

**Done when.** Every option in `options.ts` is documented; every code sample compiles (extract them into a typechecked file or test); `doc-reviewer` pass if available.

### P1-16 Phase report

**Do.** The lead: run the acceptance criteria, write `docs/phase-1-report.md` as the phase 0 report was written, update the roadmap's current phase, and stop for the owner.
