# Nestrix

Instructions for AI coding agents working on this repository. This is the one shared file: `CLAUDE.md` imports it and adds only what is specific to Claude Code.

Open-source observability for NestJS 12+: Nest-aware OpenTelemetry tracing, with an optional dashboard served by the host application. Apache-2.0. Pre-release.

**Current state:** phase 0. The repository holds documentation, the workspace toolchain and package skeletons (`packages/nestjs`, `packages/ui`, `packages/protocol`, placeholder exports only); no instrumentation exists yet. Next work: `docs/backlog/phase-0.md`.

**Remote:** `github.com/nestrix-js/nestrix`, private, already configured (`docs/decisions.md`, "GitHub: what is set up"). There is nothing left to set up on GitHub before implementing.

## Read before working

| File | What it is |
|---|---|
| `docs/architecture.md` | What we are building and why. Canonical. |
| `docs/decisions.md` | Decisions already made, open questions, and what only the owner decides. |
| `docs/nest-hooks.md` | The NestJS 12 extension points the design rests on, per adapter. |
| `docs/research.md` | Facts verified against primary sources, with dates. |
| `docs/roadmap.md` | Phases and their acceptance criteria. |
| `docs/backlog/phase-0.md` | The current task list, with a status table. |
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
- A task is done when its checks have been run and their output read. If something fails, say so with the output. Do not weaken a check to make it pass.
- A mechanism marked **(spike)** in the docs is unproven. Do not build on it until its spike has a result.
- When work contradicts a doc, fix the doc in the same change. Stale docs are worse here than usual, because agents start from them.
- Do not commit, push or publish unless the owner asks. If the owner tells a session to commit as it goes, make one commit per completed task. Commits use `git commit -s` (DCO sign-off). Publishing to npm and making the repository public are always separate, explicit requests.
- Stop for the owner at every phase gate, and for anything listed under "Things only the owner decides" in `docs/ai/orchestration.md`.

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
pnpm verify         # build, check:packages, test, lint, typecheck in that order, stopping at the first failure
```

TypeScript config: every package has its own `tsconfig.json` that extends `tsconfig.base.json`, sets `composite`, `rootDir` and `outDir`, and is added to `references` in the root `tsconfig.json`. `verbatimModuleSyntax` is on: import types with `import type`, but import classes used as Nest constructor parameters as values (an `import type` there makes `design:paramtypes` silently `Function`).

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
