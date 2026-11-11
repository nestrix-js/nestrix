# Contributing to Nestrix

Thank you for looking. The project is in phase 0: the design is written, the code is not. The most useful contributions right now are corrections to the research and the design, and help with the phase 0 spikes.

## Before you write code

Read these, in this order:

1. [docs/architecture.md](docs/architecture.md): what is being built and why.
2. [docs/decisions.md](docs/decisions.md): what is already decided. If you think a decision is wrong, open an issue with the evidence instead of working around it.
3. [docs/roadmap.md](docs/roadmap.md) and the current backlog in `docs/backlog/`: what is being worked on.

## Two rules that are not negotiable

### Clean room

The NestJS team publishes its own observability agent, `@nestjs/observe`. Since version 0.3.21 its licence forbids using it, including its source code, to develop or test a product that substitutes for their service. Nestrix is such a product.

So, while contributing to Nestrix:

- Do not read, install or run `@nestjs/observe` at any version later than 0.3.20.
- Do not copy from it, describe its internals in issues or pull requests, or benchmark against it.
- Versions up to and including 0.3.20 were MIT-licensed. If you draw on one, say so in the pull request and keep the attribution.

If you have worked with the later source recently, please contribute to parts of Nestrix it does not touch, or tell a maintainer first. This rule is a precaution, not legal advice.

### Sign-off

Every commit carries a `Signed-off-by` line, certifying the [Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "your message"
```

There is no contributor licence agreement. Your contribution is licensed under Apache-2.0, like the rest of the repository, and the copyright stays yours.

## Setup

```bash
git clone https://github.com/nestrix-js/nestrix.git
cd nestrix
pnpm install
```

Requires Node.js 22.15 or later and pnpm. Build, test and lint commands arrive with the workspace toolchain (backlog task P0-01); this section is updated then.

## What makes a change acceptable

Nestrix runs inside other people's applications, on every request. The bar follows from that:

- **It cannot change the host application's behaviour.** Instrumentation code catches its own errors. A change to request-path code comes with a test that injects a fault and shows the request still succeeds.
- **It uses public NestJS APIs only.** No imports from `@nestjs/core/internal`, no patching of framework internals.
- **It records no sensitive data by default.** No bodies, no bind parameters, no headers outside the allowlist.
- **It is tested on every adapter it claims to support:** Express, Fastify and `@nestjs/platform-node`.
- **It adds no runtime dependency** to a published package without a maintainer agreeing first.
- **Its tests can fail.** A test that passes whatever the code does is not evidence.

The full list, with the reasons, is in [AGENTS.md](AGENTS.md) under "Rules that are easy to break". It is written for AI agents working on the repository, and it applies to people too.

## Pull requests

- Keep one change per pull request, and say what it is for.
- Update the docs in the same pull request when behaviour changes. `docs/architecture.md` is the source of truth; a change that contradicts it either fixes the document or is not ready.
- Describe how you checked it: the commands you ran and what they printed.

## AI-assisted work

Much of this project is built with AI coding agents, and contributions made with them are welcome. The same bar applies. [docs/ai/orchestration.md](docs/ai/orchestration.md) describes how agents are organised here; `.claude/agents/` holds their definitions. You are responsible for what you submit, whoever typed it.

## Conduct and security

- [Code of Conduct](CODE_OF_CONDUCT.md)
- To report a vulnerability, follow [SECURITY.md](SECURITY.md). Please do not open a public issue for it.
