# Nestrix

Instructions for AI coding agents working on this repository. This is the one shared file: `CLAUDE.md` imports it and adds only what is specific to Claude Code.

Open-source observability for NestJS 12+: Nest-aware OpenTelemetry tracing, with an optional dashboard served by the host application. Apache-2.0. Pre-release.

**Current state:** phase 0 is complete and its gate is passed. The repository holds the workspace toolchain, package skeletons (placeholder exports only), example apps, the test harness, CI and release plumbing, and six spike results in `docs/spikes/`. The owner decided the phase 0 questions (D-40 to D-51 in `docs/decisions.md`; evidence in `docs/phase-0-report.md`). Phase 1 (headless tracing) is complete and the owner approved it on 2026-11-11 (`docs/phase-1-report.md`). Phase 2 (embedded dashboard) is complete and the owner approved it on 2026-11-11 (`docs/phase-2-report.md`; task list and settled public API in `docs/backlog/phase-2.md`). Phase 3 (providers, data and jobs) is next, in a fresh session; its first task is writing `docs/backlog/phase-3.md`.

**Remote:** `github.com/nestrix-js/nestrix`, private, already configured (`docs/decisions.md`, "GitHub: what is set up"). There is nothing left to set up on GitHub before implementing.

## Read before working

| File | What it is |
|---|---|
| `docs/architecture.md` | What we are building and why. Canonical. |
| `docs/decisions.md` | Decisions already made, open questions, and what only the owner decides. |
| `docs/nest-hooks.md` | The NestJS 12 extension points the design rests on, per adapter. |
| `docs/research.md` | Facts verified against primary sources, with dates. |
| `docs/roadmap.md` | Phases and their acceptance criteria. |
| `docs/backlog/phase-2.md` | The latest task list, with the settled dashboard API. Phase 1's (`phase-1.md`) holds the headless API and its rules for every task. Phase 3's is written when it starts. |
| `docs/ai/orchestration.md` | For the lead agent: which model does which work, how to brief and check subagents. |
| `docs/ai/owner-brief.md` | The owner's original brief. Background on intent; the decision log wins where they differ. |

NestJS 12, OpenTelemetry JS SDK 3, TypeScript 6 and Node 26 are newer than most training data. Where memory and these files disagree, trust the files; where it matters, check the live source (`docs/research.md` ends with how).

## Rules that are easy to break

1. **Instrumentation must never change the host application's behaviour.** Every hook, subscriber and wrapper body catches everything. A Nest request hook that throws fails the user's request; a diagnostics-channel subscriber that throws raises `uncaughtException`.
2. **Public Nest APIs only.** No `@nestjs/core/internal`, no patching Nest internals, no global exception filter, no second Nest application.
3. **No `Proxy` around provider instances.** Method wrappers copy reflect-metadata, own properties, `name` and `length`, or a method-level guard silently stops applying.
4. **ESM-only, and no top-level `await`** in anything a published entry point imports. CommonJS Nest 12 apps load the package with `require()`, which fails on top-level `await`.
5. **Instrumentation code imports `@opentelemetry/api` only.** SDK packages are touched in the setup code alone.
6. **The dashboard is closed unless something positive opens it,** and its API never emits CORS headers. The rules are in `docs/architecture.md` §4.7; each has a test.
7. **No request or response bodies, no bind parameters, no headers outside the allowlist** are recorded by default.
8. **Clean room.** Do not open, fetch, install or run `@nestjs/observe` at any version after 0.3.20, and do not benchmark against it. Its licence forbids using it to build a substitute.
9. **Versions come from the registry, not from memory.** `npm view <pkg> version`.
10. **A runtime dependency in a published package is an owner decision.** The budget is in `docs/architecture.md` §4.5.

## Working agreement

- Take tasks from the backlog in dependency order. Update the status table when a task starts and when it ends.
- **Delivery mode (owner, 2026-11-11): finish and ship first, optimise later.** Acceptance criteria are the minimum that shows a feature works: a functional test or an end-to-end check, run locally. Benchmarks, soak runs, performance targets and polish are deferred to a later optimisation pass and listed in the phase report as deferred, not failed. Test runs stay under about two minutes.
- A task is done when its local checks (`pnpm verify`, or the affected package's tests plus lint and typecheck) have been run and their output read. CI does not have to pass before moving on. If something fails, say so with the output. Do not weaken a check to make it pass.
- A mechanism marked **(spike)** in the docs is unproven. Do not build on it until its spike has a result.
- When work contradicts a doc, fix the doc in the same change. Stale docs are worse here than usual, because agents start from them.
- **Git flow:** each task is built in its own local git worktree on its own branch, committed with `git commit -s` (DCO sign-off, no co-author trailer), checked locally, then merged into local `main`. When a batch of tasks (or the phase) is done and `main` passes locally, push `main` to `origin main`. Never force-push. Publishing to npm, creating releases, setting `NPM_PUBLISH_ENABLED` and making the repository public stay separate, explicit owner requests.
- Phase gates no longer stop the session: write the phase report and carry on to the next phase. Decisions the owner used to make (open questions, runtime dependencies within the §4.5 budget) are taken by the lead agent with the conservative option and recorded in `docs/decisions.md`. The rules in "Rules that are easy to break" still apply in full; they are product correctness, security and licensing rules, not acceptance criteria.

## Splitting work across agents

A lead agent takes tasks from the backlog and hands bounded pieces to cheaper agents: mechanical work to the smallest model, implementation against a written spec to a mid-tier model, and spikes and correctness-critical code to the strongest model in ordinary use. The most expensive model is a last resort. `docs/ai/orchestration.md` has the rules, the brief template and what must be independently reviewed. Tool-specific setup, such as Claude Code's subagent definitions, lives in that tool's own file (`CLAUDE.md`).

## Commands

```bash
pnpm install        # install the workspace
pnpm build          # pnpm -r --if-present build: each package's own build script
pnpm test           # vitest run --passWithNoTests; every workspace dir with a package.json is a Vitest project
pnpm lint           # biome check . (lint and format; Markdown is not checked)
pnpm typecheck      # tsc -b --noEmit over the references in the root tsconfig.json
pnpm check:packages # publint + attw --pack --profile esm-only on each published package (their check:package script)
pnpm check:tla      # scripts/check-no-tla.mjs: require() every published entry and every built file from CommonJS and fail on a top-level await (ERR_REQUIRE_ASYNC_MODULE); needs `pnpm build` first
pnpm verify         # build, check:packages, check:tla, test, lint, typecheck in that order, stopping at the first failure
pnpm changeset      # add a changeset (needed for changes to a published package; @nestrix/nestjs and @nestrix/ui share one version)
pnpm changeset status --since=origin/main  # what the PR check runs; exits non-zero if a published package changed without a changeset
pnpm version-packages # changeset version: CI runs it for the version PR; do not run it locally and commit the result
pnpm release        # refuses to run outside .github/workflows/release.yml on main; never publish from a laptop (RELEASING.md)
```

Releases are Changesets plus npm trusted publishing and are switched off until the owner sets the `NPM_PUBLISH_ENABLED` repository variable. Agents never publish, set that variable or run `changeset publish`; `RELEASING.md` has the owner's steps.

CI runs locally with [`act`](https://nektosact.com) and Docker, without spending GitHub Actions minutes (the repository is private, 2,000 minutes a month). On colima, `--container-daemon-socket -` is required:

```bash
act push -W .github/workflows/ci.yml -P ubuntu-latest=catthehacker/ubuntu:act-latest --container-daemon-socket - -s GITHUB_TOKEN="$(gh auth token)"
act workflow_dispatch -W .github/workflows/nightly.yml -P ubuntu-latest=catthehacker/ubuntu:act-latest --container-daemon-socket - -s GITHUB_TOKEN="$(gh auth token)"
```

The `jaeger` job runs `docker compose` inside the job container, which needs the socket path inside the colima VM instead: `act push -W .github/workflows/ci.yml -j jaeger -P ubuntu-latest=catthehacker/ubuntu:act-latest --container-daemon-socket unix:///var/run/docker.sock`. Locally, `pnpm build && pnpm --filter jaeger-example check` runs the same check without `act`.

TypeScript config: every package has its own `tsconfig.json` that extends `tsconfig.base.json`, sets `composite`, `rootDir` and `outDir`, and is added to `references` in the root `tsconfig.json`. `verbatimModuleSyntax` is on: import types with `import type`, but import classes used as Nest constructor parameters as values (an `import type` there makes `design:paramtypes` silently `Function`). Biome's `useImportType` rule is off for this reason: its autofix makes exactly that change.

## Layout

```
packages/nestjs/      @nestrix/nestjs
packages/ui/          @nestrix/ui
packages/testing/     @nestrix/testing, private test harness (bootApp, in-memory spans)
packages/protocol/    private query-API types
apps/server/          phase 5
examples/             fixture apps, one per adapter and module format
spikes/               throwaway spike code, never published
benchmarks/
docs/
```
