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
| D-6 | **The repository is private for now.** The owner makes it public when they choose, for example at the first alpha. | Nothing but design documents exists yet, and the name's trademark question (O-5) is open. |

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

## Phase 0 gate decisions

Chosen by the owner on 2026-11-11 from the options in [phase-0-report.md](phase-0-report.md) §4, with the spike evidence named there.

| # | Decision | Supersedes | Why |
|---|---|---|---|
| D-40 | **OpenTelemetry SDK 3 only for 0.1.** Hosts on SDK 2.x are not supported; the docs explain the `ERESOLVE` and that they must upgrade. `@opentelemetry/api` stays a peer: Nestrix never ships its own API copy. | O-1 | A second API copy fails silently in both directions (P0-S3 Q5). Optional SDK packages remain possible later without breaking anyone. |
| D-41 | **Add `@opentelemetry/context-async-hooks` and `@opentelemetry/core` as runtime dependencies** of `@nestrix/nestjs`, for the context manager and W3C propagator when Nestrix owns the provider. | Extends the budget in architecture §4.5 (rule 10) | SDK 3's `sdk-trace` has neither (P0-S3). Official Apache-2.0 packages; `core` is already installed transitively. |
| D-42 | **fetch/undici is traced by a first-party subscriber on undici's diagnostics channels**, like the `node:http` one. `@opentelemetry/instrumentation-undici` is not used. | D-13 (the undici part) | Upstream installs a process-wide `require` hook and adds two loader libraries (P0-S2 Q1). The first-party subscriber reuses the outbound rules (suppress key, parent required, ignore list). |
| D-43 | **Sentry is supported as coexistence.** Both tools work side by side; with Sentry's defaults a request has two traces, and the docs say so. Nestrix does not trace Sentry's envelope requests. The `openTelemetryIntegration()` + `defaultIntegrations: false` one-trace setup is documented as an option with its costs. | O-2 | No tested setup gives one trace with Sentry's defaults and a working Nestrix (P0-S3 Q4). |
| D-44 | **Supported Nest versions:** `@nestjs/platform-node` from 12.3.2; Express and Fastify adapters from 12.0.0. | Adds a floor | On platform-node 12.3.0 and 12.3.1 the request context is lost after JSON body parsing (P0-S1 Q2, Q9). |
| D-45 | **D-31 stands: dashboard routes are registered in `onModuleInit`.** Its original reason (constructor registration breaks platform-node) was disproved; the reason now is uniform behaviour across adapters, with host protections (auth middleware, rate limits, HSTS) also covering the dashboard. Handlers hijack, strip CORS and set their own CSP; Nestrix detects shadowing. | Restates D-31's reason | P0-S5 trade-off table. |
| D-46 | **`ui: 'auto'` also requires a startup token.** Nestrix logs a link carrying a random token at startup; opening it stores the token in an HttpOnly cookie. An explicit opt-out exists. | Amends D-30 | A same-host reverse proxy with nginx's defaults passes every per-request loopback check (P0-S5 Q7). |
| D-47 | **Default method wrapping (level 2): controllers, queue processors and scheduled methods.** Services opt in through `include`; guard, pipe, interceptor and filter spans are an opt-in too. architecture.md §2, §4.1 and §4.2 are amended to match. | O-3; amends the enhancer-span promise in architecture §2, §4.1, §4.2 | No denylist to keep up to date, no third-party noise (P0-S6 Q1, Q7). |
| D-48 | **Level 2 does not apply under `@nestjs/testing`** for 0.2, and the docs say so. HTTP spans still work there. | — | Nest offers no public way to decorate static instances in tests (P0-S6 Q1). |
| D-49 | **mysql2 and ioredis integrations are opt-in.** Enabling one documents that the library then swallows certain errors instead of crashing. `pg` stays on when present. | D-3 ("switch on when the library is present") for mysql2 and ioredis | Any subscriber turns an unawaited ioredis failure and a listener-less mysql2 error from a crash into silence, and no way of subscribing avoids it (P0-S2 Q7). Rule 1 keeps the default. |
| D-50 | **The `pg` integration also wraps nested copies already loaded** (`require.cache` scan at enable and at `onApplicationBootstrap`). The timing is verified in a Nest app at the start of phase 3. Copies loaded later stay untraced, and the docs say so. | Resolves the nested-copy question in architecture §4.4 | MikroORM pins its own `pg` exactly (P0-S2 Q5). |
| D-51 | **pnpm's release-age gate runs in strict mode:** an install that needs a too-new version fails instead of pnpm adding exclusions on its own. | — | pnpm 12 silently added `minimumReleaseAgeExclude` entries to admit a day-old release (P0-S3). |

## Phase 2 decisions

| # | Decision | Supersedes | Why |
|---|---|---|---|
| D-52 | **Dashboard package list (amends D-1).** **Added:** `@tanstack/react-table` (v9, with `manualFiltering`/`manualSorting`, so filtering and sorting run on the server); `nuqs` with its TanStack Router adapter, its parsers built from the query-API parameter definitions in `packages/protocol`; a slim copy of the tablecn data table (table, column header, toolbar, faceted filter, view options, skeleton); shadcn `base-nova` on `@base-ui/react`, plus Dice UI components copied through the shadcn registry (`faceted`, `stat`, `relative-time-card`, `kbd`, and `combobox` if needed); `lucide-react`, `class-variance-authority`, `clsx` + `tailwind-merge`, `tw-animate-css`; `@fontsource-variable/geist-mono` for IDs and durations, with a system font stack for UI text; `cmdk` only if the budget allows. Lists page with cursors (live head plus "load older"), not page numbers. **Not used:** recharts (uPlot stays), sonner (injects `<style>` at runtime, which the CSP blocks), forms, zod, date pickers, dnd-kit, i18n, PWA, devtools in the build, and 0.x TanStack packages. Every package is a build-time `devDependency`; `@nestrix/ui` keeps no runtime dependencies. | Extends D-1 | Reuses the owner's `nestjs-monorepo-template` stack where it fits the 1 MB unpacked budget, the strict CSP, hash routing and a read-only, polled ring buffer. Code copied from that repository is limited to code the owner wrote (it is PolyForm-Noncommercial; Nestrix is Apache-2.0) and MIT code, which keeps its notice. **Size budget (owner, 2026-11-11: a target, not a hard limit):** 1 MB unpacked is the target and CI fails above the budget. If the first measured build needs more, the budget becomes the measured size plus 20%, up to 2 MB, recorded here; above 2 MB goes back to the owner. **Unverified until the first phase 2 UI task:** the measured bundle size, a CSP run with no violations under a non-root `<base href>`, and nuqs reading and writing search params inside TanStack Router's hash history. If any of these fails, this entry changes before features are built on it. |
| D-53 | **Dashboard packages after the first build (amends D-52).** (1) nuqs is kept with a small in-repo adapter on nuqs's public `nuqs/adapters/custom` entry, instead of its stock TanStack Router adapter. (2) The "no 0.x TanStack packages" item is removed: version 0.x is not a reason to reject a package. (3) Measured size recorded: `@nestrix/ui` is 547,721 bytes unpacked with every D-52 package in the bundle, so the budget stays at the 1 MB target (1,000,000 bytes, checked by `packages/ui/scripts/check-size.mjs`). | D-52 (adapter, the 0.x item; the size entry is now measured) | Owner, 2026-11-11, from P2-02's evidence. The stock adapter drops other search params under hash history: with `route=/users` set, clicking "errors only" left `#/?status=error`, because without `getSearchParamsSnapshot` nuqs merges into `location.search`, which is always empty with hash URLs. The custom adapter supplies it from the router; all P2-02 checks pass in Chromium and Firefox. The owner had not meant to rule out 0.x packages (many stable projects stay on 0.x); TanStack Router and Table themselves depend on `@tanstack/store` 0.11. CSP: the build runs under the exact policy in backlog phase 2 with no violations at a non-root `<base href>`. |
| D-54 | **`@nestrix/ui` is an optional peer of `@nestrix/nestjs`,** pinned to the same version (`peerDependenciesMeta.optional`). It is never installed by itself, like `pg`. | Reading of D-3, confirmed | Owner, 2026-11-11, at the phase 2 gate. pnpm's isolated layout means `@nestrix/nestjs` cannot resolve `@nestrix/ui` unless it is declared. |

## Open

| # | Question | Default until decided | Who |
|---|---|---|---|
| O-4 | When MongoDB driver spans arrive. | Deferred; upstream instrumentation meanwhile. | Owner |
| O-5 | Trademark search for the name, given a company called Nestrix appears to exist. | Not done. | Owner |

## GitHub: what is set up

Done on 2026-11-11 and read back from the API. Do not redo it.

- Organisation `nestrix-js` (Free plan, two-factor authentication required). Repository `nestrix-js/nestrix`, **private**, default branch `main`, remote `origin` over SSH.
- Squash and rebase merges allowed, merge commits off; head branches deleted on merge; wiki and projects off; issues on.
- Sign-off required on web-based commits (the DCO rule).
- Dependabot alerts and security updates on.
- The default `GITHUB_TOKEN` for workflows is read-only and cannot approve pull requests. A workflow that needs more declares its own `permissions`.

Not available while the repository is private on the Free plan (the API refused the ruleset with "Upgrade to GitHub Pro or make this repository public"): branch rulesets, private vulnerability reporting, secret scanning. Private repositories also get 2,000 Actions minutes a month, so keep the CI matrix lean until it is public.

### When the repository goes public

For whoever is asked to do it, in this order:

1. Read the docs once more as an outsider would; `docs/ai/owner-brief.md` and the notes on `@nestjs/observe` become public.
2. Make the repository public.
3. Add a ruleset on the default branch that blocks deletion and force-pushes. Add "require a pull request" and required status checks once outside contributors arrive; until then the owner and their agents push to `main` directly.
4. Enable private vulnerability reporting, then delete the HTML comment in `SECURITY.md` that says to.
5. Enable secret scanning and push protection.
6. npm provenance needs a public repository, so the first publish comes after this.

## Owner actions outstanding

Needed before anything is published. Local work is not blocked.

- Create the `@nestrix` npm organisation, which is also the test of whether that scope is free.
- Provide a contact for `CODE_OF_CONDUCT.md` (it still says `[INSERT CONTACT METHOD]`).
- Decide when the repository goes public (D-6).
