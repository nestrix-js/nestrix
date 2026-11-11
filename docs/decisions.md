# Decision log

Decisions already made, newest sections last. Do not reopen one silently: if work shows a decision is wrong, stop, write down the evidence, and raise it with the owner. A change is recorded as a new entry that names the entry it supersedes.

"Owner" entries were chosen by the project owner. "Plan" entries were proposed in the architecture plan and approved with it on 2026-11-11. "Review" entries amend the plan after an independent review the same day; the owner has been told about them and may overrule any.

## Owner decisions

| # | Decision | Why |
|---|---|---|
| D-1 | **Frontend:** React 19 + Vite static SPA (TanStack Router with hash history, Query, Virtual; Tailwind 4 + shadcn/ui; uPlot; waterfall in-house). | Largest contributor pool; the same base as Jaeger UI and bull-board; a static bundle can mount at a runtime path. Next.js was ruled out because static export fixes `basePath` at build time. |
| D-2 | **Licence:** Apache-2.0 for the whole repository. Contributions by DCO sign-off, no CLA. | Explicit patent grant; matches OpenTelemetry; no CLA means the project cannot be quietly relicensed. |
| D-3 | **Packages:** two published packages, `@nestrix/nestjs` and `@nestrix/ui`, one version number. Integrations for `pg`, `mysql2` and `ioredis` are built in, switch on when the library is present, can each be switched off, and load lazily. | Ten packages would mean ten release trains, and several would be empty. Split an integration out only when it needs a heavy or conflicting dependency. |
| D-4 | **GitHub home:** the `nestrix-js` organisation; repository `github.com/nestrix-js/nestrix`. | `github.com/nestrix` is taken by a dormant organisation. |
| D-5 | **Model use for development:** Opus 5.5 leads and delegates to Opus, Sonnet and Haiku subagents. Fable 5.2 only when badly needed. | Cost. See [ai/orchestration.md](ai/orchestration.md). |

## Plan decisions

| # | Decision | Why |
|---|---|---|
| D-10 | NestJS 12+ only. Node 22.15+. ESM-only packages with no top-level `await`. | Nest 12 is ESM-only and has the hooks; OpenTelemetry SDK 3 needs Node 22.15. Nest 11 is feasible later but needs a CommonJS build and a second test matrix. |
| D-11 | Build on OpenTelemetry: the API everywhere, SDK 3.x for the pipeline, OTLP as the only wire format. No custom telemetry protocol. | Interoperability is a product requirement. |
| D-12 | Do not build the default experience on upstream's module-patching instrumentations. Use Nest's public hooks and library-published diagnostics channels. | Upstream needs `--experimental-loader` on Nest 12, on Node features that are deprecated or discouraged, and its Nest 12 support was reverted. |
| D-13 | First-party instrumentation for Nest, `node:http` client, mysql2, ioredis and `pg`. Reuse upstream for undici/fetch and BullMQ. | Each first-party piece is a thin subscriber or wrapper. See architecture §4.5. |
| D-14 | Use only public, documented Nest APIs. No `@nestjs/core/internal`, no patching Nest internals, no global exception filter, no second Nest application. | So a Nest release cannot break Nestrix silently, and Nestrix cannot change the host's behaviour. |
| D-15 | Mode order: headless and embedded in the first release; standalone server in phase 5. | Embedded is headless plus one span processor. Standalone brings a receiver, Postgres, auth and a Docker image, and should follow real users. |
| D-16 | Standalone storage: PostgreSQL with Drizzle, spans partitioned by day, retention by dropping partitions. Publish the measured ingest envelope. No second database. | Owner's stated preference; honest about scale. |
| D-17 | Tooling: pnpm workspaces, `tsc` builds, Vitest, Biome, Changesets with fixed versioning, npm trusted publishing with provenance. No Turborepo, no `init` CLI for now. | Smallest toolchain that does the job. |
| D-18 | Clean-room rule: nobody working on Nestrix opens, installs or runs `@nestjs/observe` later than 0.3.20, and it is not benchmarked. | Its licence forbids using it to build a substitute. A precaution, not legal advice. |
| D-19 | Health checks, log storage and metric storage are not built. | `@nestjs/terminus` and existing backends do them. |

## Review amendments

| # | Decision | Supersedes | Why |
|---|---|---|---|
| D-30 | **Dashboard is local-only by default.** `ui: 'auto'` serves it only when `NODE_ENV` is `development` or unset **and** the request is loopback (socket peer, `Host` header, no forwarding headers). Anything else needs `ui.enabled` plus `auth` (built-in token or custom `authorize`). The dashboard API rejects cross-site requests and emits no CORS headers. | The plan's "on whenever `NODE_ENV` is not `production`" | An app deployed with `NODE_ENV` unset or `staging` would have exposed traces, SQL and stack traces publicly. |
| D-31 | **Dashboard routes are registered in `onModuleInit`.** | The plan's "at provider construction" | It is the point the Nest source confirms on every adapter. A constructor runs before `initHttpServer`. |
| D-32 | **HTTP span lifecycle:** start in `setOnRequestHook`, end on the raw response's `close` event. `setOnResponseHook` is not used. The request hook is synchronous and calls `done()` exactly once. | The plan's three-hook design | The response hook misses aborts on Express and platform-node and can hang on Fastify. |
| D-33 | **No hook chaining for the request hook; one hook-based APM per process.** Detect another one at bootstrap and warn. Export `composeInstrument` for the `instrument` slot. | The plan's "chains any callback already present" | The request and response hooks have no getters. |
| D-34 | **Method wrappers copy metadata, own properties, `name` and `length`; wrap prototype methods only; are cached per class; leave functions and non-class values untouched; never use `Proxy`.** | Adds requirements to the plan | Otherwise a method-level guard can become invisible and fail open. |
| D-35 | **Route statistics are counted before sampling.** Trace and error lists are sampled and the UI says so. | The plan's phase 6 placement of pre-sampling metrics | At a 10% sample rate the dashboard's error rate would otherwise be wrong from the first release. |
| D-36 | **The query API is the contract between UI and backends.** No shared storage interface is promised until a second implementation exists. | The plan's shared `TraceStore` interface | Speculative abstraction three phases early. |
| D-37 | **Redaction** happens where Nestrix sets attributes and again in the store processor. No guarantee is made for exporters the host owns. | The plan's "before a span reaches any processor" | Nestrix cannot run ahead of processors on a host-owned provider. |
| D-38 | **Microservice client spans** come from wrapping `send` / `emit` on client instances; the dispatch hook only injects context. The hybrid-app fallback is a pre-request hook on the microservice instance with `deferInitialization: true`. | The plan's phase 4 wording | The dispatch hook cannot time a span, and `NestApplication` has no `registerPreRequestHook`. |
| D-39 | **Phase 0 has six spikes**, adding dashboard mounting and instance-decorator wrapping. A platform-node example app is added. Packaging is checked by pack-and-install, not by provenance on a local registry. | The plan's four spikes | The two riskiest mechanisms had no spike. Provenance cannot be tested locally. |

## Open

| # | Question | Default until decided | Who |
|---|---|---|---|
| O-1 | How do hosts on OpenTelemetry SDK 2.x adopt Nestrix? The peer ranges of SDK 2.x and 3.x do not overlap, so today they cannot install it. | SDK 3.x only for 0.1. Revisit with spike 3's results; one option is to make the SDK packages optional and load them only when Nestrix owns the provider. | Owner, after spike 3 |
| O-2 | Supported setup alongside `@sentry/nestjs`. | None promised. | Spike 3 |
| O-3 | What `NestrixInstrument` wraps by default. | Nothing is assumed. | Spike 6 |
| O-4 | When MongoDB driver spans arrive. | Deferred; upstream instrumentation meanwhile. | Owner |
| O-5 | Trademark search for the name, given a company called Nestrix appears to exist. | Not done. | Owner |

## Owner actions outstanding

Needed before anything is published. Local work is not blocked.

- Create the `nestrix-js` GitHub organisation.
- Create the `@nestrix` npm organisation, which is also the test of whether that scope is free.
- Provide a contact for `CODE_OF_CONDUCT.md`, and enable private vulnerability reporting on the repository for `SECURITY.md`.
