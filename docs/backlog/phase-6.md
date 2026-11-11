# Phase 6 backlog: logs, metrics and 1.0

Objective, deliverables and acceptance: [roadmap.md](../roadmap.md#phase-6-logs-metrics-and-10). How to run it: [ai/orchestration.md](../ai/orchestration.md), the delivery mode in `AGENTS.md`, the phase 3 backlog's "Rules for every task". Log and metric work runs in parallel with phases 3–5 (it needs only phase 1); the documentation site, API review and 1.0 preparation come after phases 3–5 land. Decisions: D-64 to D-66 in [decisions.md](../decisions.md).

## Status

| ID | Task | Tier | Depends on | Status | Notes |
|---|---|---|---|---|---|
| P6-00 | Backlog, decisions D-64 to D-66 | lead | — | done | |
| P6-01 | Log correlation (`NestrixLogger`, `getTraceIds`) and optional OTLP log export | sonnet | P6-00 | done | Merged; 17 tests; no `api-logs` needed (logs API is in `@opentelemetry/api`). |
| P6-02 | Request-duration and runtime metrics over OTLP | opus | P6-00 | done | Reviewed; export starts at bootstrap (host provider wins), `metrics.export`, teardown race, `url.scheme`. |
| P6-03 | Documentation site | sonnet | phases 3–5 | done | VitePress in `docs-site/`, `pnpm docs:build` (options reference checked against `options.ts`). Standalone page to refresh after P5-06. |
| P6-04 | API review and fixes | opus reviewer + sonnet | phases 3–5 | done | Fixes applied per D-69 (changeset `api-review-1-0`). |
| P6-05 | Compatibility matrix, upgrade path from 0.x, 1.0 readiness | sonnet + lead | P6-04 | done | `docs/compatibility.md`, `docs/upgrading.md`, "1.0 readiness" below. No version bump or release (owner's). |
| P6-06 | Phase report | lead | all | done | `docs/phase-6-report.md`. |

## Settled design

- **No new runtime dependencies (D-64).** OTLP log export needs `@opentelemetry/sdk-logs` (the logs API is in `@opentelemetry/api` 1.10) and `@opentelemetry/exporter-logs-otlp-http`; metric export needs `@opentelemetry/sdk-metrics` and `@opentelemetry/exporter-metrics-otlp-http`. They are **optional peer dependencies**, loaded with a dynamic `import()` only when the feature is on. When one is missing, Nestrix logs one line with the install command and carries on without that signal. Recording metrics goes through `@opentelemetry/api`'s metrics API (already a peer), so a host-owned `MeterProvider` receives them with no extra package.
- **Log correlation is opt-in and patches nothing (D-65).** Nest's logger is not patched (rule 2). `NestrixLogger extends ConsoleLogger` adds `trace_id` and `span_id` of the active span (text: a ` trace_id=… span_id=…` suffix; JSON mode: two fields), used as `NestFactory.create(AppModule, { logger: new NestrixLogger() })` or `app.useLogger(...)`. `getTraceIds(): { traceId, spanId } | undefined` serves pino, winston and `nestjs-pino`'s `mixin`. With `logs.export` on and the packages installed, `NestrixLogger` also emits each record as an OTLP log record (severity mapped from the Nest level, the context as `code.namespace`-style attribute `nestrix.log.context`, the active span's context attached); Nestrix owns the `LoggerProvider` only when the host has none.
- **Metrics (D-66).** `http.server.request.duration` (histogram, seconds, attributes `http.request.method`, `url.scheme`, `http.route`, `http.response.status_code`, `error.type` on errors, buckets per the HTTP semantic conventions) recorded in the existing response `close` handler for every request, sampled or not; runtime metrics through observable instruments from `node:perf_hooks` and `process` (`nodejs.eventloop.delay.p50/p99/max`, `v8js.memory.heap.used` and `v8js.memory.heap.space.size` per `v8js.heap.space.name`, `process.memory.usage` (RSS), `process.cpu.time` per `cpu.mode`; current semantic-convention names, checked in the installed package: semantic-conventions 1.45.0 deprecates `v8js.memory.heap.limit` in favour of `v8js.memory.heap.space.size`, so P6-02 reports the latter). Export over OTLP/HTTP to `/v1/metrics` of the same endpoint as traces (`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` honoured), every 60 s (`OTEL_METRIC_EXPORT_INTERVAL`), only when export is on and the packages are installed.
- New options (types added by the tasks in `options.ts`, resolution in `resolve-options.ts`):
  ```ts
  logs?: { export?: boolean };            // default false
  metrics?: false | { runtime?: boolean }; // default: request-duration on (API only), runtime on; export when the packages are installed and an endpoint is set
  ```

## P6-01 Logs

Owns `packages/nestjs/src/logs/**`, `test/logs/**`. `NestrixLogger` must never throw from a log call (a failure in correlation or export falls back to the plain `ConsoleLogger` output and is counted). Tests: ids appear inside a request and not outside; JSON mode; `getTraceIds`; export to a local OTLP receiver stub with the packages installed (devDependencies); missing packages produce the one log line; a host `LoggerProvider` is used when present.

## P6-02 Metrics

Owns `packages/nestjs/src/metrics/**`, `test/metrics/**`, and a small guarded addition to the `close` handler in `http/server.ts`. Tests: the histogram records on all three adapters with route and status, at sample rate 0 too; runtime instruments report; export to a stub OTLP receiver; a host `MeterProvider` receives the request metric; missing packages produce one log line and no failure; a throwing meter does not change the response.

## P6-03 Documentation site

VitePress (devDependency) in `docs-site/` (workspace package, private): getting started, levels 1–3, dashboard, security model, standalone server, microservices, logs and metrics, configuration reference (from `options.ts` doc comments), compatibility, FAQ (Sentry, SDK 2, `@nestjs/testing`). `pnpm --filter docs-site build` passes. Not deployed (the repository is private).

## P6-04 API review

A `reviewer` reads the whole public surface (`packages/nestjs/src/index.ts` exports, `options.ts`, the query API in `packages/protocol`, the server's configuration) as a 1.0 freeze candidate: naming consistency, defaults, anything that would need a breaking change later. Fixes with an exact list go to Sonnet; renames get a deprecation path only if something was already published (nothing was, so rename freely before 1.0).

## P6-05 1.0 readiness

`docs/compatibility.md` (Nest, Node, adapters, OpenTelemetry SDK and API, `pg`/`mysql2`/`ioredis`/BullMQ, transports, browsers for the UI) from what CI and the tests actually run; `docs/upgrading.md` from 0.x; a "1.0 blockers" list (none open, or each one named). No version bump, tag or publish.

## 1.0 readiness

Written for P6-05 on 2026-11-11. Detail pages: [compatibility.md](../compatibility.md) (what is tested, per row, with the test or CI job) and [upgrading.md](../upgrading.md) (0.x to 1.0). Nothing here bumps a version or tags anything.

### Phase 6 acceptance (roadmap.md)

| Criterion | Status | Evidence |
|---|---|---|
| A documented upgrade path from 0.x | Met | `docs/upgrading.md`: every rename, removal and default change in the changesets (chiefly `api-review-1-0.md` and `node-26-only.md`), with before and after code. Nothing was ever released, so the "0.x" in question is source builds; the page says so. |
| The compatibility matrix published | Met | `docs/compatibility.md`, also served by the docs site at `/reference/compatibility`; the README's "Supported versions" links to it. |
| No open issue labelled as a 1.0 blocker | Met, with a caveat | The repository has no `1.0 blocker` label and `gh issue list --state open` returned no issues (2026-11-11). The label does not exist, so the check is "no open issues at all", not "none labelled". |
| Validation: the full matrix in CI | Met as designed | `ci.yml` on `main`: `verify`, `consume` (esm, cjs), `jaeger`, `e2e` all green (run 43046693547). The "matrix" is one Node line and three Nest versions by design (D-55, `ci.yml` header comment). The nightly workflow (latest Nest 12.x) has no run yet; trigger it once (`gh workflow run nightly.yml`) before releasing. |
| Validation: the examples run as smoke tests against the release candidate | Partly met | `consume` installs packed tarballs into fresh ESM and CommonJS apps and boots them; `jaeger` runs two example services; `e2e` boots the example apps with `NestrixModule`. The Fastify and platform-node adapters are covered by the conformance tests, not by a packed-tarball smoke test. |

### Known blockers

None open against the acceptance criteria. Gaps and limits that are not blockers, each with where it is recorded:

- **No performance numbers.** Benchmarks and soak runs were deferred by delivery mode (phase reports, "Deferred, not failed"). The README carries only one measured install size and startup cost.
- **`@nestjs/microservices` peer range raised to `^12.0.4`** (lead, 2026-11-11), the first version with `ClientProxy#setOnDispatchHook`; earlier 12.0.x installs now warn as a peer mismatch instead of silently losing propagation.
- **Untested:** gRPC, MQTT 3 propagation, NATS servers without headers, custom transports, Firefox and WebKit in CI, Windows, Postgres older than 18 for the standalone server, other OTLP senders for the standalone server (`compatibility.md` lists each).
- **Docs-site status banner.** `docs-site/index.md` said option names may still change before 1.0; reworded here, and to be updated again when the version is set.

### Owner steps before going public and releasing

Only the owner does these (`AGENTS.md`; `docs/decisions.md`, "Owner actions outstanding" and "When the repository goes public"; `RELEASING.md`, "One-time setup"):

1. **Decide the version.** Both packages are `0.0.0`, `.changeset/pre.json` is in pre mode (`alpha`), and every pending changeset is `minor`. Nothing in the repository requests `1.0.0`. For 1.0.0 the owner leaves pre mode (`pnpm changeset pre exit`) and adds a `major` changeset for both packages (they are `fixed` together); with the current setup the result would be 0.1.0 alphas. Not decided here.
2. Create the `@nestrix` npm organisation on npmjs.com with 2FA (also the test that the scope is free; if it is taken, the package names change).
3. Trademark search for the name (O-5: a company called Nestrix appears to exist).
4. Provide a contact for `CODE_OF_CONDUCT.md` (it still says `[INSERT CONTACT METHOD]`).
5. Make the repository public (D-6) after reading the docs as an outsider (`docs/ai/owner-brief.md` and the notes on `@nestjs/observe` become public) and scanning the history (commands in `RELEASING.md`).
6. Once it is public: a ruleset on `main` blocking deletion and force-push; enable private vulnerability reporting and delete the HTML comment in `SECURITY.md`; enable secret scanning and push protection.
7. GitHub Actions settings: workflow permissions read, and "Allow GitHub Actions to create and approve pull requests" (or set `RELEASE_PAT`).
8. The first npm release is done by hand from a clean `main`, with `RELEASING.md` as the script; then configure trusted publishing for each package (`release.yml`, "Allow direct `npm publish`", 2FA required, tokens disallowed).
9. Set `NPM_PUBLISH_ENABLED=true` (the switch), then check the provenance badge after the first CI release.
10. Run the nightly workflow once and read its result.
