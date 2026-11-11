# Phase 3 backlog: providers, data and jobs (0.2)

Objective, deliverables and acceptance: [roadmap.md](../roadmap.md#phase-3-providers-data-and-jobs-02). How to run this backlog: [ai/orchestration.md](../ai/orchestration.md) and the delivery mode in `AGENTS.md` (minimal functional checks, local only; benchmarks deferred). Design: [architecture.md](../architecture.md) §4.3 (level 2), §4.4 (level 3); decisions D-47 to D-50, D-56, D-57 and the phase 3 decisions D-58 to D-63 in [decisions.md](../decisions.md). Evidence: [spikes/P0-S6.md](../spikes/P0-S6.md) with its code in `spikes/p0-s6/src/wrap.ts` and `rules.ts` (the reference wrapper), [spikes/P0-S2.md](../spikes/P0-S2.md) with `spikes/p0-s2/` (the reference `pg` wrapper and channel subscribers).

## Status

| ID | Task | Tier | Depends on | Status | Notes |
|---|---|---|---|---|---|
| P3-00 | Backlog, option types, method-call sink, query API v1 additions (classes, map) | lead | — | done | This file; `methods`, `integrations`, `serviceVersion`, `user` in `options.ts` (types only); `src/methods/sink.ts`; protocol `ClassStats*`, `AppMap*`. |
| P3-01 | Level 3: `pg` (timing check first), `mysql2`, `ioredis`; statement sanitising; container tests | opus | P3-00 | done | Reviewed; fixes: per-call pool token (Object.create), EVAL-family name only. |
| P3-02 | Level 2: `NestrixInstrument`, `composeInstrument`, own-class rule, entry methods, enhancers, awkward-class corpus | opus | P3-00 | done | Reviewed; fixes: prototype classes, @Global root, multi-app config, suffix-first kinds, weak plans; D-67 (2) built. |
| P3-03 | Releases and users; trace `type`; traces filters `type`, `release`, `user` | opus | P3-00 | done | Merged; Fastify passes the `FastifyRequest` (req.user visible), Express/platform-node the `IncomingMessage`. 1,339 tests. |
| P3-04 | Class statistics (pre-sampling) and `GET api/v1/classes` | sonnet | P3-00 | done | 3 adapters; `methodsEnabled` stub until P3-02 merges. |
| P3-05 | App map and `GET api/v1/map` | sonnet | P3-00 | done | 21 tests; nearest-rank percentiles; 200-node cap. |
| P3-06 | UI: classes view and map view | sonnet | P3-00 | done | 778 KB of 1 MB; 123 e2e pass. |
| P3-07 | UI: trace view query insights (slow, repeated), links between traces, release/user/type in the request list | sonnet | P3-03 | done | 783 KB; 73 chromium e2e. |
| P3-08 | BullMQ: documented setup, example, linked job trace; acceptance end-to-end (three queries + a job) | sonnet | P3-01, P3-02, P3-03 | done | One trace: BullMQ's consumer span is a child of the producer (not a link); `new BullMQOtel({ tracerName })`. |
| P3-09 | Reviews: P3-01, P3-02, P3-03 | opus reviewer | each | done | Each found real defects; all fixed and merged. |
| P3-10 | Documentation: README, architecture §4.3/§4.4/§7, nest-hooks | sonnet + lead | all | todo | |
| P3-11 | Phase report | lead | all | done | `docs/phase-3-report.md`. |

Statuses: `todo`, `doing`, `review`, `done`, `blocked` (say on what).

Order. Wave 1, in parallel: P3-01, P3-02, P3-03 (Opus, disjoint files), P3-04, P3-05, P3-06. Wave 2: P3-07, P3-08, reviews as each Opus task lands. Then P3-10, P3-11. Deferred (delivery mode): the level 2 benchmark deltas at sample rates 1 and 0.1; listed in the report as deferred.

## Rules for every task

- `AGENTS.md` rules, architecture §4.2 "Rules for every hook and subscriber", and the phase 1 and 2 backlogs' rules still apply. Every wrapper body, subscriber and user callback is wrapped in try/catch; a failure is counted through `diagnostics.countFailure(...)` and the host's call proceeds unchanged.
- Instrumentation imports `@opentelemetry/api` only (rule 5).
- Each task works in its own git worktree on its own branch, based on `main` after P3-00. Commit with `git commit -s` (no co-author trailer). The lead merges.
- File ownership keeps parallel agents apart. Shared files (`core.ts`, `resolve-options.ts`, `dashboard/api.ts`, `store/protocol-types.ts`, `index.ts`, `ui/app/router.tsx`, `ui/app/components/app-shell.tsx`) may be edited by several tasks: keep those edits small and self-contained (new functions, new lines), so the lead's merge is mechanical.
- New option resolution goes in `resolve-options.ts` as its own function per option group, with tests in `test/resolve-options.test.ts` or a new test file. Invalid values throw at `forRoot()` like existing options.
- A new query-API shape goes in `packages/protocol/src/types.ts` and is mirrored in `packages/nestjs/src/store/protocol-types.ts` with a drift check in `test/store-protocol.test.ts` (pattern already there). Parameter specs are copied in `dashboard/api.ts` annotated with the protocol spec type (pattern already there).
- Container-backed tests (Postgres, MySQL, Redis) start containers with `docker run` from a Vitest `globalSetup` (random host ports, `--rm`), and skip with a printed reason when Docker is not reachable, except when `CI` is set, where they fail. Keep each container test file under about 30 seconds.
- Test devDependencies are fine (`mysql2`, `ioredis`, `bullmq`, `@nestjs/bullmq`, `bullmq-otel`, `@nestjs/schedule`, `@nestjs/config`). Versions from `npm view` (rule 9). A new runtime dependency of a published package is not allowed in this phase.
- A change to a published package comes with a changeset (`pnpm changeset`, minor for `@nestrix/nestjs` and `@nestrix/ui` together).
- Done means: the task's tests, `pnpm lint` and `pnpm typecheck` pass, and the affected package's full test suite passes; output read.

## Public API

Types are in `packages/nestjs/src/options.ts` (P3-00). Resolution is each owning task's job.

```ts
// main.ts: level 2
import { NestrixInstrument, composeInstrument } from '@nestrix/nestjs';
const app = await NestFactory.create(AppModule, { instrument: NestrixInstrument });
// with another tool's instrument:
NestFactory.create(AppModule, { instrument: composeInstrument(NestrixInstrument, other) });

NestrixModule.forRoot({
  serviceVersion: process.env.GIT_SHA,      // P3-03; default chain in options.ts
  user: (req) => (req as any).user?.id,     // P3-03; off by default
  methods: {                                // P3-02
    enabled: true,                          // default
    include: [MyDynamicService, /Gateway$/],
    exclude: ['HealthService'],
    enhancers: ['guard'],                   // default false
  },
  integrations: {                           // P3-01
    pg: true,                               // default true (on when installed)
    mysql2: false,                          // default false (D-49)
    ioredis: false,                         // default false (D-49); { rootSpans: true } keeps root commands
  },
});
```

`NestrixInstrument` is a plain object `{ instanceDecorator }`. `composeInstrument(...instruments)` returns one whose `instanceDecorator` applies each in order, each guarded so a throwing one passes the instance on unchanged (and is counted).

Query API additions (types in `packages/protocol`):

| Route | Params | Response | Task |
|---|---|---|---|
| `GET api/v1/classes` | `windowMinutes` 15 or 60 | `ClassStatsResponse` | P3-04 |
| `GET api/v1/map` | `windowMinutes` 15 or 60 | `AppMapResponse` | P3-05 |
| `GET api/v1/traces` | adds `type` (`http`/`job`/`scheduled`/`other`), `release`, `user` | `TraceSummary` gains `type`, `release?`, `user?` | P3-03 |

`MetaResponse.service.version` already exists; P3-03 fills it from the resolved `service.version`.

### Method span shape (P3-02)

- Name `ClassName.method`. Kind `INTERNAL`. Attributes: `code.function.name` = `ClassName.method`, `nestrix.class` = `ClassName`, `nestrix.method` = `method`, `nestrix.component` = a `MethodClassKind` (`src/methods/sink.ts`). Entry methods add `nestrix.entry` = `scheduled` or `job`.
- Kind of class: `controller` (the controller watermark), `processor` (a `@Processor` class from `@nestjs/bullmq`, by its metadata key), `guard`/`pipe`/`interceptor`/`filter` (by the method names `canActivate`/`transform`/`intercept`/`catch`, as in `spikes/p0-s6/src/rules.ts`), otherwise `repository` when the name ends in `Repository`, `service` when it ends in `Service`, else `provider`.
- Exceptions: recorded as an exception event, status error; rethrown unchanged.
- Every completed call, sampled or not, is reported to `getMethodCallSink()?.record(...)` with its wall-clock duration. The SAMPLED fast path (architecture §4.3) skips the span, never the report.

### Database span shape (P3-01)

Current OpenTelemetry database semantic conventions (check the installed `@opentelemetry/semantic-conventions` for exact names): `db.system.name` (`postgresql`, `mysql`, `redis`), `db.query.text` (literals replaced by `?`; for Redis the command and key only, never values), `db.operation.name`, `db.namespace`, `server.address`, `server.port`. Name: `db.operation.name` plus the target when cheaply known, else the system name. Kind `CLIENT`. Errors: exception event and status error. Bind parameters are never recorded (rule 7). A database span covers the query only, not pool wait (D-59).

## Tasks

### P3-01 Level 3: `pg`, `mysql2`, `ioredis`

Owns `packages/nestjs/src/integrations/**`, `packages/nestjs/test/integrations/**` and the container `globalSetup`.

1. **First, the D-50 timing check** in a real Nest app (ESM and CJS): is a nested `pg` copy already in `require.cache` when the integration enables (NestrixCore constructor) and at `onApplicationBootstrap`, for an app whose ORM (MikroORM pins its own `pg`; a local fixture with a nested `node_modules/pg` is enough) loads `pg` at import time and one that loads it lazily in a provider factory? Write the result into architecture §4.4 and `research.md`. If the scan at those two points misses the common case, say so in the report and pick the conservative fix (document it; do not patch loaders).
2. `pg`: wrap `Client.prototype.query` and `Pool.prototype.query` of the `pg` that `createRequire` from the package reaches, plus every `…/node_modules/pg/lib/index.js` in `require.cache`, idempotently, at enable and at `onApplicationBootstrap`. Pool/client de-duplication with a reference-counted mark per config object (architecture §4.4). Query spans start when the client sends the query (D-59): the pool wrapper records the caller's context with the token and the client wrapper opens the span with that parent. Callback, promise and submittable (`pg-cursor`, `pg-query-stream`) forms, all as in `spikes/p0-s2/`. On by default; `integrations.pg: false` turns it off.
3. `mysql2` (opt-in): subscribe to its TracingChannels with the `mysql2:pool:connect` context fix (architecture §4.4), `query` and `execute`.
4. `ioredis` (opt-in): subscribe to its channels; root `redis` spans (no active span at command time) are dropped unless `rootSpans: true` (D-60).
5. Statement sanitising in one shared helper: SQL literals (strings, numbers, hex, booleans in value positions, `IN (…)` lists collapsed) replaced by `?`, comments kept out, length capped (2,048 characters). Unit tests with tricky inputs (quotes inside strings, dollar-quoted strings, escaped quotes, comments, unterminated strings: fail closed to a placeholder text, never the raw statement).
6. Wiring: `installIntegrations(options, diagnostics)` returning a disposer, called from `NestrixCore`'s constructor, and a re-scan hook called from `NestrixCore.onApplicationBootstrap` (add the hook; keep the edit small). Option resolution for `integrations` in `resolve-options.ts`.
7. Tests against real containers (Postgres 18, MySQL 8.4, Redis 8; tags from Docker Hub): spans and parents for each form; two concurrent requests whose queries interleave land in their own traces (pg pool contention; mysql2 queued pool caller); an integration that is off produces no spans and subscribes to nothing; with `pg` absent the integration reports itself disabled; a throwing tracer does not change query results (inject a fault).

Do not: add ORM-specific code, record bind parameters, patch module loaders, or subscribe to `ioredis:batch` / `ioredis:connect`.

### P3-02 Level 2: method spans

Owns `packages/nestjs/src/methods/**` (except `sink.ts`, which it uses as is) and `packages/nestjs/test/methods/**`.

- `NestrixInstrument` and `composeInstrument` exported from `index.ts`.
- The wrapper follows architecture §4.3 and `spikes/p0-s6/src/wrap.ts` (strategy **own**): copy every reflect-metadata key, own properties, `name` and `length`; non-enumerable own properties on the instance; prototype untouched; cached per class; call the method the prototype holds at call time; plain native promises followed with `then(end, endAndRethrow)`; Observables, other thenables, generators, accessors untouched; SAMPLED fast path; idempotent.
- **The own-class rule (D-58).** The decorator sees only the instance. Every class instance that is a controller or an `@Injectable()` class gets wrappers installed in a disabled state, holding one shared per-class plan object. `NestrixCore`'s constructor (which runs after Nest's module scan and before most instances exist) injects `ModulesContainer` (public, from `@nestjs/core`) and computes the own set: start at the root module (the module no other module imports), follow `imports` entries of the static `@Module()` metadata that are classes (not dynamic-module objects, promises or `forwardRef`s), and collect the classes those modules list statically in `controllers` and `providers` (class or `useClass`). Plans for own classes are switched on; `include` switches more on, `exclude` switches off; enhancers follow `methods.enhancers`. Read module metadata with the `MODULE_METADATA` key strings exported by `@nestjs/common` and `Reflect.getMetadata`; read only public properties of the container's modules (`metatype`). Instances decorated after the computation are planned immediately. A disabled wrapper calls straight through (measure its cost in a unit test comment, not a benchmark).
- **Entry methods (D-62).** Methods carrying `@nestjs/schedule` metadata (`@Cron`, `@Interval`, `@Timeout`; read the metadata key strings from the installed package, do not import it at runtime) always start a new root span linked to the span active at call time, with `nestrix.entry = 'scheduled'`. A `@Processor` class's `process` method is a child of the active span when there is one (BullMQ's own consumer span), else a new root, with `nestrix.entry = 'job'`.
- Not under `@nestjs/testing` (D-48): nothing to build; add a test that documents it.
- `methods.enabled: false`, or no `NestrixInstrument`, produces no method spans and `ClassStatsResponse.methodsEnabled` false (export a `methodsEnabled()` getter for P3-04).
- **Acceptance tests**: a route with a method-level guard returns 403 with `NestrixInstrument` on, on all three adapters; the awkward-class corpus (`#private` members, request-scoped providers, providers holding callable objects, `Map`/`EventEmitter` subclasses, plain function middleware, a memoised promise, an Observable-returning method, a getter) behaves exactly as without instrumentation; a library-like provider registered by a dynamic module is not traced, and is when `include`d; an app with `@nestjs/schedule` and `@nestjs/config` produces no spans at startup; a scheduled method gives one root span per tick; spans nest controller → service → repository under the server span.

### P3-03 Releases, users, trace type

Owns the server-span user attribute in `http/server.ts` (small, guarded addition), `otel/resource.ts` changes, and the `TraceSummary`/`traceListParams` additions end to end (protocol, fixtures, mirror, store, API, UI mock data in `packages/ui/e2e/mock-api.ts` so the UI build and tests stay green).

- `serviceVersion` resolution (D-63) into `service.version` on the Nestrix-owned resource; `MetaResponse.service.version` filled.
- `user`: called once per sampled request when the server span ends, before `span.end()`; result stringified, capped at 256 characters, set as `user.id`; throws and invalid results counted, never propagated. Verify which request object each adapter's request hook receives (on Fastify, is `request.user` set by guards visible from it?) and correct the option's doc comment in `options.ts` to say exactly what users get. Subject to the `redact` hook as usual.
- `TraceSummary.type`: `http` when the root is a server span; `job` when the root is a consumer span or has `nestrix.entry = 'job'`; `scheduled` when it has `nestrix.entry = 'scheduled'`; else `other`. `release` from the trace's resource `service.version`; `user` from the root's `user.id`. Filters `type`, `release` (exact), `user` (exact).
- Tests: version chain; user on all three adapters with a guard that sets `req.user`; throwing user function; filters; drift checks.

### P3-04 Class statistics

Owns `packages/nestjs/src/stats/class-stats.ts`, its tests, the `classes` handler in `dashboard/api.ts`.

- Implements `MethodCallSink` (`src/methods/sink.ts`): per class and method, wall-clock buckets like `stats/route-stats.ts` (reuse its bucketing approach), counting calls, errors, total and max duration. Bounded: at most 500 classes × 50 methods; beyond that, count into a single `(other)` entry. `record` must not allocate per call in the steady state.
- Installed with `setMethodCallSink` while the dashboard is on (from `NestrixCore`, small edit), removed on shutdown.
- `GET api/v1/classes`: window sums; `ownAvgMs` per method estimated from the store's sampled spans in the window (spans with `nestrix.class`/`nestrix.method`: duration minus the summed durations of direct children, clipped at 0); `methodsEnabled` from P3-02's `methodsEnabled()` (until P3-02 lands, a local stub returning whether any call was recorded; the lead swaps it at merge).
- Tests: unit tests of the aggregator; an HTTP test that feeds the sink directly and reads the endpoint.

### P3-05 App map

Owns `packages/nestjs/src/store/app-map.ts`, its tests, the `map` handler in `dashboard/api.ts`.

- From the stored traces whose root started inside the window: one `app` node (the service name); for each client or producer span, a target node: databases by `db.system.name` (or legacy `db.system`) + `server.address` + `db.namespace`, Redis as `cache`, HTTP clients by `server.address` (+ port when not default), messaging by `messaging.system` + `messaging.destination.name`, anything else `other`. Edges from the app to each target with calls, errors (status error), p50 and p95. Bounded: at most 200 nodes.
- Tests with synthetic spans fed through the store.

### P3-06 UI: classes view and map view

Owns `packages/ui/app/views/classes/**`, `packages/ui/app/views/map/**`, their e2e specs and mock data additions in `packages/ui/e2e/` (new files; a small addition to `mock-api.ts` routes).

- Classes view: table of classes (name, kind, calls, errors, avg, total, own) expandable to methods; sortable; window toggle 15/60 min like the routes view; empty state when `methodsEnabled` is false that shows the one line to add in `main.ts`.
- Map view: the app node in the centre and its targets around it, drawn as SVG (no new graph library; D-52's package list holds), edge labels with calls / p95 / error rate, colour by error rate; a note that it is built from sampled traces. A list fallback below the drawing for accessibility.
- Navigation entries in the shell. Size budget (1 MB) still checked by `check-size.mjs`.

### P3-07 UI: trace insights, links, request list

Owns `packages/ui/app/views/trace/**` and `views/requests/**` changes.

- Trace view: database spans slower than 100 ms are highlighted in the waterfall; a "Queries" panel lists repeated statements within the trace (same `db.query.text` three or more times) with count and total time, and clicking one selects those spans.
- Span links: a span's links are listed in its detail panel; a link to a trace in the store opens it.
- Request list: `type` filter (all / HTTP / jobs / scheduled), release and user columns (hidden when no trace has them), `release` and `user` filters.

### P3-08 BullMQ and the acceptance end-to-end

Owns `examples/` additions (a jobs example or an addition to `express-esm`), `packages/nestjs/test/e2e-phase3/**`, and README's BullMQ section draft.

- The documented setup: `@nestjs/bullmq` with BullMQ's `telemetry: new BullMQOtel('<name>')` from `bullmq-otel`, forwarded to workers. Verify what trace shape it gives (child in the same trace, or a new trace with a link) and write it down.
- The acceptance test (roadmap phase 3): one request runs three `pg` queries and enqueues a job; all three queries are children of the right spans; the job's processing is in a linked trace (or a child, as BullMQ makes it; the test asserts what was found and the docs say it), with the processor's method span under it. Real Postgres and Redis containers.

### P3-09 Reviews

`reviewer` on P3-01, P3-02 and P3-03 each, given the diff and the task section, not the lead's conclusions. Findings with an exact fix go to Sonnet; mechanism questions to the original Opus agent.

### P3-10 Documentation

README: level 2 (`main.ts` line, what is traced by default and how to change it, the promise caveat, not under `@nestjs/testing`), level 3 (pg on, mysql2/ioredis opt-in with the swallowed-errors warning, nested `pg` copies), BullMQ, users and releases, the classes view and map. Architecture §4.3, §4.4, §7 brought in line. A doc-reviewer pass.

### P3-11 Phase report

`docs/phase-3-report.md`: what is done and verified, deferred items (benchmarks), decisions taken.
