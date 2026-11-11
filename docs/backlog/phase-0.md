# Phase 0 backlog

Objective, acceptance and context: [roadmap.md](../roadmap.md#phase-0-foundations-and-spikes). How to run this backlog (who does what, on which model, and how results are checked): [ai/orchestration.md](../ai/orchestration.md).

## Status

Update this table as work moves. One line of notes at most; detail goes in the task's section or the spike's result file.

| ID | Task | Tier | Depends on | Status | Notes |
|---|---|---|---|---|---|
| P0-01 | Workspace toolchain | sonnet | — | done | TS 6.0.3, Vitest 4.1.12, Biome 2.6.6; `pnpm verify` passes on the empty workspace. |
| P0-02 | Package skeletons | sonnet | P0-01 | done | Three packages build with `.d.ts`; publint and attw (`--profile esm-only`) pass; `pnpm verify` passes. |
| P0-03 | CI | sonnet | P0-02 | review | All jobs green locally under `act` (ci: 7/7, nightly: 1/1, 2026-11-11); needs a green run on GitHub at the first push. |
| P0-04 | Example apps | sonnet, then haiku | P0-01 | done | Four apps pass `check:run`; Express apps add `POST /upload-multer` (multer interceptor path for P0-S1 Q2). |
| P0-05 | Test harness | sonnet | P0-02, P0-04 | done | `packages/testing`: `bootApp` on 3 adapters (+ `@nestjs/testing`), in-memory spans; no context manager registered; Vitest's oxc honours `emitDecoratorMetadata` from tsconfig. |
| P0-S1 | Spike: HTTP adapter hooks | opus | P0-05 | done | Mechanism holds on all 3 adapters (12.0.0, 12.3.2, 12.4.2); reviewed, fixes applied, docs updated. platform-node floor 12.3.2 is an owner question. |
| P0-S2 | Spike: library spans without a preload | opus | P0-05 | review | `docs/spikes/P0-S2.md`: Q1, Q2, Q6 pass; Q3, Q4, Q5, Q7 partly (mysql2 pool context, ioredis offline queue, nested `pg` missed, library behaviour changes on subscribe). Needs owner input. |
| P0-S3 | Spike: coexistence with a host SDK and Sentry | opus | P0-S1 | review | Host SDK 3 + duck-typed processor pass (ESM/CJS, 3 adapters, Node 22.15/26); Sentry: no one-trace setup with defaults (O-2); SDK 2 facts for O-1. Review fixes applied. |
| P0-S4 | Spike: CommonJS consumption | sonnet | P0-02 | done | Loads clean on 22.15/24.22/26.13; `pnpm check:tla` in verify; Jest needs `--experimental-vm-modules` (24.9+) or a transform on 22.x. Reviewed; doc edits applied. |
| P0-S5 | Spike: dashboard mounting | opus | P0-05 | done | Works on all 3 adapters + testing; reviewed, fixes applied, docs updated. D-31 and the `ui: 'auto'` token are owner decisions. |
| P0-S6 | Spike: instance-decorator wrapping | opus | P0-05 | done | Own-property wrappers work on 3 adapters; reviewed, fixes applied, docs updated. O-3, enhancer-span conflict, @nestjs/testing coverage are owner decisions. |
| P0-06 | Release plumbing, without publishing | sonnet | P0-03 | done | Changesets (fixed: nestjs + ui), release workflow gated on `vars.NPM_PUBLISH_ENABLED` (unset), PR changeset check; `pnpm release` refuses outside CI. Nothing published. Owner steps in RELEASING.md. |
| P0-07 | Phase report and doc updates | lead | all | todo | |

Statuses: `todo`, `doing`, `review`, `done`, `blocked` (say on what).

P0-S1, S2, S5 and S6 are independent of each other once P0-05 is done and can run in parallel.

## Rules for every task

- Resolve versions live (`npm view <pkg> version`, or the registry). Do not write a version from memory: NestJS 12, TypeScript 6, Vitest 4 and OpenTelemetry SDK 3 are newer than most training data. [research.md](../research.md) has the versions seen on 2026-11-11.
- A task is `done` when its "Done when" checks have been run and their output read, not when the code looks right.
- If a check fails and the fix is not obvious, report the failure with its output. Do not weaken the check.
- No commits unless the owner asks. When they do, use `git commit -s` (DCO).

## Setup tasks

### P0-01 Workspace toolchain

**Do.** Extend the root `package.json` and add the shared config:
- Dev dependencies: TypeScript 6, Vitest 4, Biome, `publint`, `@arethetypeswrong/cli`.
- `tsconfig.base.json`: `module` and `moduleResolution` `nodenext`, `target` matching Node 22, `strict`, `experimentalDecorators`, `emitDecoratorMetadata`, `declaration`, `sourceMap`, `verbatimModuleSyntax` if it is compatible with legacy decorators (check; say what you found).
- `biome.json` for lint and format.
- Root scripts: `build`, `test`, `lint`, `typecheck`, and `verify` that runs all four.

**Done when.** `pnpm install` succeeds; `pnpm verify` runs and passes on the (still empty) workspace; `AGENTS.md`'s Commands section lists the real commands.

### P0-02 Package skeletons

**Do.** Create `packages/nestjs`, `packages/ui` and `packages/protocol` per [architecture.md](../architecture.md) §5 and §8.
- `@nestrix/nestjs`: `"type": "module"`, an `exports` map with `types` and `default`, `files`, `engines.node >=22.15.0`, `license` Apache-2.0, `repository` pointing at `github.com/nestrix-js/nestrix`. Peers: `@nestjs/common` and `@nestjs/core` `^12`, `@opentelemetry/api` on the range SDK 3 supports, `reflect-metadata`, `rxjs`; optional peers `@nestjs/microservices`, `pg`. No runtime code beyond a placeholder export.
- `@nestrix/ui`: publishes `dist/` only; placeholder asset and a generated manifest of its files.
- `packages/protocol`: private, types only.
- No top-level `await` anywhere in published entry points.

**Done when.** `pnpm -r build` emits `dist/` with `.d.ts`; `publint` and `attw --pack` pass for both published packages; `pnpm verify` passes.

### P0-03 CI

**Do.** GitHub Actions for a library, using the `package-ci` skill if it is available in the session (it sets up pnpm, Biome, a single `verify` script, a Node matrix, and the packaging checks), and the `github-actions` skill's rules for pinning and permissions.
- Matrix: Node 22.15, 24, 26.
- A job that packs both packages, installs the tarballs into a fresh ESM fixture and a fresh CommonJS fixture, and boots a trivial Nest 12 app in each.
- A scheduled nightly run that installs the latest `@nestjs/*` 12.x.

**Done when.** The workflow passes `actionlint` (or the skill's own validation), and, once the owner has asked for it to be pushed, a run on `nestrix-js/nestrix` is green. Until a run has been seen, the status is `review`, not `done`.

**Know before you start.** The repository exists and is private (see "GitHub: what is set up" in [decisions.md](../decisions.md)). The default workflow token is read-only, so each workflow declares the `permissions` it needs. Private repositories get 2,000 Actions minutes a month: run the full Node matrix on pull requests and `main`, not on every branch push, and keep the nightly job to one Node version.

### P0-04 Example apps

**Do.** Four minimal Nest 12 apps under `examples/`: `express-esm`, `fastify-esm`, `node-esm` (platform-node), `express-cjs`. They double as fixtures, so each exposes the same routes:

| Route | Purpose |
|---|---|
| `GET /hello` | Trivial 200 |
| `GET /users/:id` | Route template |
| `GET /private` | Controller guard that always rejects (403) |
| `GET /private-method` | Method-level `@UseGuards` that always rejects |
| `GET /boom` | Throws a plain `Error` |
| `GET /teapot` | Throws an `HttpException` with a 4xx status |
| `GET /stream` | Streams for about a second |
| `POST /echo` | JSON body |
| `POST /upload` | Multipart |
| `POST /upload-multer` | Multipart through Nest's multer `FileInterceptor`; Express apps only |
| `GET /out` | Calls another URL with `fetch` and with `node:http` |

Build the Express ESM app first (sonnet). The other three are the same app on another adapter or module format and can go to haiku with the first as the template.

**Done when.** Each app starts with `pnpm --filter <name> start` and a script hits every route and prints the status codes, which match the table.

### P0-05 Test harness

**Do.** In a private workspace package: `bootApp(adapter, moduleOptions)` returning the app, its base URL and the spans captured by an in-memory exporter; a helper to wait for a span by name; teardown that closes the app and flushes. It must work for all three adapters and for an app built through `@nestjs/testing`.

**Done when.** One Vitest test per adapter boots the fixture module, sends `GET /hello`, and asserts that zero spans were captured (nothing is instrumented yet) and the app shut down cleanly.

### P0-06 Release plumbing, without publishing

**Do.** Changesets with fixed versioning across the published packages; a release workflow using npm trusted publishing with provenance, following the `npm-release` skill if available. Add a pull-request check that changes come with a changeset.

**Done when.** `pnpm changeset status` works. Nothing is published: the `@nestrix` npm organisation does not exist yet, npm provenance needs the repository to be public, and publishing is the owner's call.

### P0-07 Phase report and doc updates

**Do.** Done by the lead, not delegated. Read every spike result. Update `architecture.md`, `nest-hooks.md` and `research.md` so no **(spike)** marker remains unresolved; add decision-log entries for anything that changed; list what the results force on the roadmap. Then stop and report to the owner.

**Done when.** The owner has the report. Phase 1 does not start before they answer.

## Spikes

A spike answers questions; it does not ship features. Each one produces:

- Throwaway code under `spikes/<id>/` (a workspace package, never published). Keep it runnable: its checks become regression tests later.
- A result file `docs/spikes/<id>.md` from the template at the end of this file.

Time-box each spike to what its questions need. If a question cannot be answered, say so and say what would answer it.

Read [nest-hooks.md](../nest-hooks.md) before any of them. It describes what the source says should happen; the spike finds out what does.

### P0-S1 HTTP adapter hooks

On Express, Fastify and platform-node, with hooks set from a provider constructor in a module imported by the fixture app:

1. Does a request hook that calls `done()` inside `AsyncLocalStorage.run()` make the store visible in guards, interceptors, pipes, the handler, and code after an `await` in the handler?
2. Does that hold for `POST /echo` (JSON body) and `POST /upload` (multipart), where body parsing happens between the hook and the handler?
3. What exactly does `setOnRouteTriggered` receive with: no prefix; a global prefix; URI versioning; header versioning with two versions of one route; a controller path with parameters? Does it fire before guards? Can the active store be read inside it?
4. Does a `close` listener on the raw response fire for: a normal response, a 404, a guard rejection, a thrown error, the stream route, and a client that aborts mid-stream? What distinguishes the abort?
5. What happens to the user's request when the request hook throws synchronously? (Confirms why ours must not.)
6. Which requests never reach the request hook on each adapter (malformed URL, over-long parameter)?
7. Under `@nestjs/testing` (`Test.createTestingModule(...).compile()` then `createNestApplication()`): is `HttpAdapterHost.httpAdapter` defined when providers are constructed? If not, where is the earliest point it is, and are routes already registered by then?
8. With `NestFactory.createMicroservice` and `createApplicationContext`: what does `HttpAdapterHost` hold?
9. On the lowest Nest 12 the hooks support (12.0.0 for Express and Fastify): same answers?

### P0-S2 Library spans without a preload

No `--import`, `--require` or loader flag anywhere. In both an ESM and a CommonJS fixture app:

1. undici/fetch: with `@opentelemetry/instrumentation-undici` enabled from module initialisation, does `fetch` produce a client span parented to the active span, and is `traceparent` sent?
2. `node:http` client: can a subscriber on `http.client.request.created` call `request.setHeader('traceparent', …)` and have it sent? Do `http.client.response.finish` and `http.client.request.error` give enough to end the span? Which Node versions in the matrix publish these channels?
3. mysql2 3.20+: do its TracingChannels fire for `query` and `execute`, on a pool and on a connection, in the caller's async context? What data do they carry (statement text, error)?
4. ioredis 5.11+: same questions for `ioredis:command`.
5. `pg`: after resolving `pg` with `createRequire` from inside the Nestrix package and wrapping `Client.prototype.query` and `Pool.prototype.query`, are queries from the app traced when the app uses raw `pg`, TypeORM, Drizzle and MikroORM? What happens when an ORM carries its own nested copy of `pg` at a different version (construct this with pnpm overrides)? Does resolution work under pnpm's strict layout with `pg` as an optional peer?
6. Prisma 7 with `@prisma/adapter-pg`: do its queries pass through the wrapped `pg` methods?
7. Does any of the above change the libraries' behaviour: callbacks vs promises, cursors and streams, errors, `unhandledRejection`?

### P0-S3 Coexistence

1. The host registers an OpenTelemetry SDK 3.x `TracerProvider` before Nest bootstraps. Does `trace.setGlobalTracerProvider()` return `false` for Nestrix, and do spans created through the API land in the host's exporter with correct parents?
2. With `nestrixSpanProcessor()` added to the host's `spanProcessors`, does the in-memory store receive every span, including the host's own?
3. Can Nestrix tell, without deprecated API, that the host registered a context manager and a propagator, and avoid registering second ones?
4. `@sentry/nestjs` 11 with default settings alongside Nestrix: how many traces does one request produce, and which `traceparent` goes out on an outbound call? Then with Sentry's documented custom OpenTelemetry setup: is it one trace?
5. What does installation look like for a host on SDK 2.x (`@opentelemetry/api` below 1.10)? Record the exact package-manager output. This feeds open decision O-1; do not decide it.

### P0-S4 CommonJS consumption

1. A CommonJS Nest 12 app `require()`s the built ESM-only package on Node 22.15, 24 and 26. Does it load without flags or warnings?
2. Do decorators and `reflect-metadata` behave (one copy of `reflect-metadata`, `design:paramtypes` present)?
3. Does a top-level `await` anywhere in the import graph of the entry point break it, including in dependencies (the OpenTelemetry packages)? Add a CI check that fails if one appears.
4. Jest and Vitest in a CommonJS project: which Node versions can load it?

### P0-S5 Dashboard mounting

Register a JSON route and a static-asset route through `httpAdapter.get(...)` from `onModuleInit`, on all three adapters:

1. Are both reachable with: no global prefix; a global prefix; URI versioning on?
2. Do the host's global guards, interceptors and pipes run for them? (They should not.)
3. With a host catch-all controller route (`@Get('*splat')` or the adapter's equivalent): reachable or shadowed? If shadowed, can Nestrix detect it at startup?
4. Which host-level things still apply, per adapter: `app.use()` middleware registered before and after `listen`, `enableCors()`, `app.useSecurityHeaders()`, `helmet()`, compression?
5. With permissive host CORS, do responses carry `Access-Control-Allow-Origin`? Can the handler remove or override it on each adapter?
6. Do `reply`, `setHeader` and `status` work identically for JSON and for a binary asset with `Content-Type`, `Cache-Control` and `Content-Encoding`?
7. What does the handler receive as the request on each adapter, and how are the socket's remote address, the `Host` header and `X-Forwarded-For` read from it?
8. Under `@nestjs/testing`: are the routes registered?
9. Is constructor-time registration actually broken on platform-node, as the source comments suggest?

### P0-S6 Instance-decorator wrapping

With `NestFactory.create(AppModule, { instrument: { instanceDecorator } })`:

1. What passes through the decorator in a realistic app? Log the constructor name, whether it carries Nest's controller or injectable marker, and whether it is a function. Include: controllers, services, guards, pipes, interceptors, filters, class middleware, function middleware, factory providers, request-scoped and transient providers, `ConfigService`, `Reflector`, a TypeORM or Drizzle provider, a `ClientProxy`.
2. Wrap prototype methods without `Proxy` (compare: assigning wrapped functions as own properties; swapping to a per-class derived prototype). For each: does a method-level `@UseGuards` on a controller handler still reject? Do `@HttpCode`, `@Header`, custom `SetMetadata` read through `Reflector`, and parameter decorators still work? What must be copied to the wrapper for that?
3. Do static and request-scoped controllers read the handler from the instance or the prototype?
4. Classes with `#private` fields and methods; classes extending `Map` or `EventEmitter`; providers holding a callable object in a field: unchanged behaviour?
5. Do `@Cron` / `@Interval` methods (`@nestjs/schedule`) and `@Processor` classes (`@nestjs/bullmq`) call the wrapped method?
6. Cost: per-instance construction time and per-call overhead with a non-recording span, for 1, 10 and 100 methods.
7. Propose the default rule for what gets wrapped (open decision O-3), with the evidence from question 1.

## Spike result template

```markdown
# <ID> <title>

Date, Node versions, Nest version, adapter versions used.

## Answers

| # | Question | Result | Evidence |
|---|---|---|---|
| 1 | … | pass / fail / partly / not answered | test name or command and the output that shows it |

## What this changes

- In architecture.md / nest-hooks.md / research.md: …
- Decisions affected: …

## Chosen approach

One paragraph. If the design in architecture.md stands, say so.

## Left open

What could not be answered, and what would answer it.
```
