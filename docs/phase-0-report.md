# Phase 0 report

Date: 2026-11-11. Written by the lead for the owner at the phase 0 gate. Phase 1 does not start until the owner has answered the decisions in §4.

## 1. Summary

Phase 0 removed the technical unknowns. The core design in `docs/architecture.md` holds: Nest-aware tracing works on Express, Fastify and platform-node, from ESM and CommonJS apps, beside a host's own OpenTelemetry SDK, with no preload flag. Six spikes found about twenty corrections, all of them now written into `architecture.md`, `nest-hooks.md` and `research.md`. Twelve questions need the owner; five of them block phase 1.

Nothing is published and nothing is pushed. `main` has one signed-off commit per completed task.

## 2. Acceptance criteria (roadmap, phase 0)

| Criterion | Result | Evidence |
|---|---|---|
| Every spike has a pass or fail per question, a chosen approach, and the resulting doc edits | **Met** | `docs/spikes/P0-S1.md` … `P0-S6.md`; each was independently reviewed, fixed and merged; doc edits applied |
| CI is green on the Node matrix | **Met locally, not yet on GitHub** | `act` runs: `ci` 7/7 jobs (verify on Node 22.15.0, 24, 26; consume ESM and CJS; ci-ok), `nightly` 1/1. A GitHub run needs a push (owner) |
| The packed tarballs install into a fresh ESM app and a fresh CommonJS app, and both boot | **Met** | `consume` job (`.github/ci-fixtures/run.sh`), run locally on Node 26 (ESM, CJS) and 22.15.0 (CJS): `GET / -> 200` |

`pnpm verify` on `main`: 662 tests pass, 56 skip (database tests skip without Docker; they pass with the spike containers up).

## 3. What was done

### Done and verified

| Task | Check that showed it |
|---|---|
| P0-01 Workspace toolchain | `pnpm verify` |
| P0-02 Package skeletons | `pnpm -r build`, publint and attw (`--profile esm-only`) in `verify` |
| P0-04 Example apps (Express ESM, Fastify ESM, platform-node ESM, Express CJS) | `pnpm --filter <app> check:run`: every route matches the table |
| P0-05 Test harness (`packages/testing`) | its tests, on all three adapters and through `@nestjs/testing` |
| P0-06 Release plumbing | `pnpm changeset status`; actionlint; `pnpm release` refuses outside CI. Publishing is off until the owner sets `NPM_PUBLISH_ENABLED` |
| P0-S1 … P0-S6 | spike tests (kept as regression tests under `spikes/`), each re-run by an independent reviewer |

### Done, not fully verified

- **P0-03 CI**: green under `act`, never run on GitHub. Not covered locally: the pnpm cache, GitHub's `ubuntu-latest` image, `setup-node` downloading 22.15.0 there.
- **P0-06's changeset PR check**: the git-diff step could not run under `act` inside a worktree; verified with `changeset status --since=main` locally.

### Found along the way

- **Biome's `useImportType` autofix broke Nest dependency injection** (rewrote a constructor-injected class to `import type`). Rule turned off; `AGENTS.md` explains why.
- **pnpm 12 policies**: it refuses to install packages with unapproved build scripts (`allowBuilds` entries added for spike tools), and it silently added `minimumReleaseAgeExclude` entries to let a day-old Sentry release in (reverted). See decision 12.
- **Clean-room slip, corrected**: an earlier session cited the licence file inside the `@nestjs/observe` 0.3.25 tarball. No code was used. The citation now points at the npm registry's licence field. Nothing in the lockfile, `node_modules` or the code references `@nestjs/observe`.
- **Worktrees** created for parallel agents were sometimes cut from an old commit; each agent now checks and fast-forwards first.

### What the spikes changed in the design

- **HTTP (P0-S1).** The request-hook mechanism holds on 12.0.0, 12.3.2 and 12.4.2. Under `@nestjs/testing` Nestrix subscribes to `HttpAdapterHost.init$` instead of falling back to an interceptor. Response outcome at `close` is read with a three-line rule. 404 naming under non-URI versioning has a rule. platform-node needs 12.3.2.
- **Libraries (P0-S2).** fetch, `node:http` and Prisma pass. The `node:http` span ends on response `close`, or at the head when nobody reads the body. `pg` needs reference-counted de-duplication and misses nested copies. mysql2 needs its pool context lent from `pool:connect`. Subscribing to mysql2 or ioredis changes those libraries' behaviour.
- **Coexistence (P0-S3).** Works beside a host SDK 3 in ESM and CJS apps. The route hook touches only Nestrix's own span. Outbound tracing honours OpenTelemetry's suppress key and needs a parent span. Tracers are obtained at use time; globals are registered no earlier than `NestFactory.create`. Span processor methods never throw or reject. Sentry is not a solved case.
- **CommonJS (P0-S4).** CommonJS Nest apps load the ESM-only package on Node 22.15, 24 and 26 with no flags. `pnpm check:tla` enforces the no-top-level-await rule. Nothing may use `instanceof` on OpenTelemetry classes (two API copies in CommonJS apps).
- **Dashboard (P0-S5).** Mounting works on all three adapters and under `@nestjs/testing`. Handlers hijack the raw response, strip CORS headers and catch everything; assets are written raw. Host exception filters and middleware do reach dashboard routes. The loopback rule reads the raw socket, has a longer forwarding-header list, and has a stated limit.
- **Method wrapping (P0-S6).** Own-property wrappers keep guards and metadata working; the prototype is never changed. Wrappers resolve methods at call time, follow only native promises, start roots for scheduled jobs and queue processors, and skip span creation under an unsampled parent (about 70 ns per call). Static classes are never wrapped under `@nestjs/testing`.

## 4. Decisions for the owner

Each has options and the lead's recommendation. Answer briefly, for example "1a, 2a, 3b …". The evidence is in the named spike result.

### Blocking phase 1 (headless tracing)

**1. O-1: hosts on OpenTelemetry SDK 2.x** (P0-S3 Q5)
Today npm refuses the install (`ERESOLVE`) and pnpm warns. A second `@opentelemetry/api` copy fails silently in both directions, so whatever is chosen, Nestrix never ships its own API copy.
- (a) SDK 3 only for 0.1; document the `ERESOLVE` and that SDK 2 hosts must upgrade.
- (b) Make the SDK packages optional, loaded only when Nestrix owns the provider; widen the API peer range so SDK 2 hosts can use Nestrix through their own provider.
- (c) Officially accept API 1.9 for API-only use, without (b)'s packaging change.
- **Recommendation: (a)** for 0.1. It is the current interim position, and SDK 2 hosts can still be served later through (b) without breaking anyone.

**2. Rule 10: two new runtime dependencies** (P0-S3)
When Nestrix owns the provider, SDK 3 needs an AsyncLocalStorage context manager and a W3C propagator, neither of which `sdk-trace` exports.
- (a) Add `@opentelemetry/context-async-hooks` (no dependencies) and `@opentelemetry/core` (already installed transitively, pinned exactly by `sdk-trace`).
- (b) Add `core` only and write a small first-party context manager.
- (c) Write both.
- **Recommendation: (a).** Both are official Apache-2.0 packages; together they add almost nothing to the install, and a hand-written context manager is exactly the correctness-critical code worth not owning.

**3. D-13: tracing fetch/undici** (P0-S2 Q1)
The upstream instrumentation works, but constructing it installs a process-wide `require` hook and brings `require-in-the-middle` and `import-in-the-middle` into the dependency budget.
- (a) Keep upstream; document the hook; measure its startup and per-`require` cost in phase 1.
- (b) Write a first-party subscriber on undici's diagnostics channels, like the `node:http` one (about 150–250 lines, no dependencies).
- **Recommendation: (b).** It removes a global hook from every host process, shrinks the budget, and reuses the rules the `node:http` subscriber needs anyway (suppress key, parent required, ignore list).

**4. O-2: Sentry** (P0-S3 Q4)
With Sentry 11's defaults, one request produces two traces. Every one-trace setup tested costs either Sentry's base integrations or Nestrix's own context and dashboard.
- (a) Supported as coexistence: both tools work, two traces, documented; Nestrix ignores Sentry's envelope requests.
- (b) Document the `openTelemetryIntegration()` + `defaultIntegrations: false` setup (one trace; loses Sentry's global handlers, breadcrumbs and sessions).
- (c) Document `enableOpenTelemetrySetup: true` (one trace; Nestrix's dashboard stays empty).
- (d) Not supported.
- **Recommendation: (a)** for 0.1, with (b) documented as an option for teams that want one trace. Revisit when Sentry changes its integration.

**5. platform-node version floor** (P0-S1 Q2, Q9)
On 12.3.0 and 12.3.1 the request context is lost after JSON body parsing.
- (a) Support platform-node from 12.3.2; Express and Fastify from 12.0.0.
- (b) Support from 12.3.0 and document the JSON-body gap.
- **Recommendation: (a).**

### Before phase 2 (embedded dashboard)

**6. D-31: where dashboard routes are registered** (P0-S5, trade-off table)
- (a) Keep `onModuleInit`: same behaviour on every adapter, host protections (auth middleware, rate limits, HSTS) also cover the dashboard. Nestrix strips host CORS, sets its own CSP, and detects shadowing.
- (b) Register from the constructor through `init$`: no shadowing and no host CORS on responses on Express and platform-node, but host protections stop applying there while they still apply on Fastify. Relies on `init$` timing that matches Nest's code, not its JSDoc.
- **Recommendation: (a).** Uniform behaviour across adapters is easier to secure and to document, and the stripping and CSP code is needed for Fastify either way.

**7. D-30: a startup token for `ui: 'auto'`** (P0-S5 Q7)
A same-machine reverse proxy with nginx's defaults passes every per-request loopback check; only `NODE_ENV` then protects the dashboard.
- (a) `ui: 'auto'` also requires a token printed at startup (one click stores it in a cookie), with an explicit opt-out.
- (b) Document the limit only.
- **Recommendation: (a).** It keeps "closed unless something positive opens it" true in the one configuration the other checks cannot see.

### Before phase 3 (providers, data, jobs)

**8. O-3: what gets method spans by default** (P0-S6 Q1, Q7)
- (a) Controllers, plain `@Injectable` services and queue processors, minus a denylist of framework classes (on the fixture: 2–4 spans per request, 0 at boot; third-party services get spans unless excluded).
- (b) Controllers, queue processors and scheduled methods only; services opt in through `include`.
- Both leave guards, pipes, interceptors and filters unwrapped, which conflicts with the enhancer spans promised in architecture §2, §4.1 and §4.2. Either amend those sections or add enhancer spans as an option.
- **Recommendation: (b),** with enhancer spans as an opt-in and §2/§4.1/§4.2 amended. A default that never surprises beats one that needs a denylist kept up to date.

**9. Method spans under `@nestjs/testing`** (P0-S6 Q1)
Nest offers no public way to wrap static classes in tests.
- (a) Document that level 2 does not apply under `@nestjs/testing`.
- (b) Run a follow-up spike on in-place decoration through `ModulesContainer` before `registerRouter`.
- **Recommendation: (a)** for 0.2; (b) if users ask.

**10. D-3: mysql2 and ioredis on by default?** (P0-S2 Q7)
Any subscriber, Nestrix's or another tool's, turns an unawaited ioredis failure and a listener-less mysql2 error from a crash into silence. No subscription style avoids it.
- (a) On by default; document the change.
- (b) Opt-in per integration.
- (c) Wrap their prototypes like `pg` instead (avoids the change; brings back nested-copy and resolution issues).
- (d) Subscribe only to channels that change nothing (no query spans).
- **Recommendation: (b).** Rule 1 is the project's first rule, and hiding a crash in production is a behaviour change users should choose knowingly.

**11. Nested `pg` copies** (P0-S2 Q5)
MikroORM pins `pg` exactly, so its copy is often not the app's, and gets no spans.
- (a) Also wrap every `pg` already in `require.cache`, at enable and at `onApplicationBootstrap` (timing still to verify in a Nest app; copies loaded later stay untraced).
- (b) Document nested copies as unsupported.
- **Recommendation: (a),** with the timing verified first thing in phase 3.

### Repository settings

**12. pnpm release-age exclusions** (P0-S3)
pnpm 12 added `minimumReleaseAgeExclude` entries on its own to admit a day-old release.
- (a) Set `minimumReleaseAgeStrict: true` (or the equivalent in the installed pnpm) so it fails instead.
- (b) Leave as is.
- **Recommendation: (a).** A supply-chain gate that edits itself is not a gate.

### Unchanged, still with the owner

- Pushing `main` so CI (P0-03) gets its GitHub run.
- O-4 (MongoDB driver spans) and O-5 (trademark search for the name, before any publish).
- The one-time publishing setup in `RELEASING.md`.

## 5. What the decisions mean for the roadmap

- **Phase 1** gains, from the spikes: the `init$` path under `@nestjs/testing` with a nightly test; the close-time outcome rule; 404 naming; the route hook's own-span rule; outbound suppress/parent/ignore rules; lazy tracers and late global registration; guarded processor methods; the `node:http` unread-body fallback. With 3(b), a first-party undici subscriber replaces the upstream dependency.
- **Phase 2** gains hijack-and-strip handlers, raw asset writes, a shadowing detector (startup self-request or passive detection, chosen in phase 2), and, with 7(a), the startup token.
- **Phase 3** starts by verifying the `pg` cache-scan timing and settling the pool-wait rule (the lead proposes database spans cover the query only), and implements O-3 as decided.
- No phase is blocked by a failed mechanism. Fable was not needed.

## 6. Cost note

The six spikes, their reviews and fix rounds ran on Opus, several in parallel; the session hit the five-hour usage window once. Fix rounds now go back to the original agent when they need judgement and to Sonnet when they are mechanical (recorded with the owner's agreement).
