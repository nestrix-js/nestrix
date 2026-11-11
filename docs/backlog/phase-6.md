# Phase 6 backlog: logs, metrics and 1.0

Objective, deliverables and acceptance: [roadmap.md](../roadmap.md#phase-6-logs-metrics-and-10). How to run it: [ai/orchestration.md](../ai/orchestration.md), the delivery mode in `AGENTS.md`, the phase 3 backlog's "Rules for every task". Log and metric work runs in parallel with phases 3–5 (it needs only phase 1); the documentation site, API review and 1.0 preparation come after phases 3–5 land. Decisions: D-64 to D-66 in [decisions.md](../decisions.md).

## Status

| ID | Task | Tier | Depends on | Status | Notes |
|---|---|---|---|---|---|
| P6-00 | Backlog, decisions D-64 to D-66 | lead | — | done | |
| P6-01 | Log correlation (`NestrixLogger`, `getTraceIds`) and optional OTLP log export | sonnet | P6-00 | done | Merged; 17 tests; no `api-logs` needed (logs API is in `@opentelemetry/api`). |
| P6-02 | Request-duration and runtime metrics over OTLP | opus | P6-00 | review | Merged; 59 tests; `v8js.memory.heap.space.size` replaces the deprecated heap limit. |
| P6-03 | Documentation site | sonnet | phases 3–5 | todo | |
| P6-04 | API review and fixes | opus reviewer + sonnet | phases 3–5 | todo | |
| P6-05 | Compatibility matrix, upgrade path from 0.x, 1.0 readiness | sonnet + lead | P6-04 | todo | No version bump or publish (owner's). |
| P6-06 | Phase report | lead | all | todo | |

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
