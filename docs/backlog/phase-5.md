# Phase 5 backlog: standalone server (0.4)

Objective, deliverables and acceptance: [roadmap.md](../roadmap.md#phase-5-standalone-server-04). Design: architecture §4.10, D-15, D-16, D-36, D-56 (map across services). How to run it: [ai/orchestration.md](../ai/orchestration.md), the delivery mode in `AGENTS.md`, and the phase 3 backlog's "Rules for every task" (worktree per task, `git commit -s`, containers from a Vitest `globalSetup`, local checks). Runs in parallel with phases 3 and 4.

`apps/server` is `@nestrix/server`, **private** (not published to npm; distributed as a Docker image, D-15). Its runtime dependencies are not bound by the published-package budget of architecture §4.5, but each one is listed in the phase report.

## Status

| ID | Task | Tier | Depends on | Status | Notes |
|---|---|---|---|---|---|
| P5-00 | Backlog, `apps/server` skeleton, ingest model (`src/ingest/model.ts`) | lead | — | done | |
| P5-01 | Server bootstrap, configuration, OTLP/HTTP receiver (protobuf + JSON, gzip, limits, partial success, API keys) | opus | P5-00 | todo | Untrusted input: review required. |
| P5-02 | Storage: schema, migrations, day partitions, retention, ingest writer, rollups | opus | P5-00 | done | `src/storage/`, `migrations/0001_init.sql`; schema notes for P5-03 in `src/storage/schema.ts` and `traces.ts`. |
| P5-03 | Query API over Postgres; protocol additions for several services | sonnet | P5-01, P5-02 | todo | |
| P5-04 | UI hosting and admin login | opus | P5-01 | todo | Security: review required. |
| P5-05 | UI: service selector, map across services | sonnet | P5-03 | todo | |
| P5-06 | Docker image, `docker compose`, example apps end to end, short ingest measurement | sonnet | P5-03, P5-04 | todo | |
| P5-07 | Reviews of P5-01 and P5-04 | opus reviewer | each | todo | |
| P5-08 | Documentation, phase report | sonnet + lead | all | todo | |

## Settled design

- **One port**, default `4318` (`PORT`): `POST /v1/traces` (receiver), `GET /api/v1/*` (query API, same shapes as the embedded dashboard), `/` (the UI build from `@nestrix/ui`), `/login`, `/logout`.
- **Configuration** from the environment, validated at start (a bad value exits with a clear message): `DATABASE_URL` (required), `NESTRIX_INGEST_KEYS` (comma-separated keys, each at least 32 characters), `NESTRIX_INGEST_AUTH=none` (explicit opt-out for local demos, logged as a warning on every start), `NESTRIX_ADMIN_PASSWORD` (at least 12 characters; without it the UI and query API answer 503 and a log line says why; ingest still works), `NESTRIX_SESSION_SECRET` (optional; random per start otherwise), `NESTRIX_RETENTION_DAYS` (default 7).
- **Ingest auth:** `Authorization: Bearer <key>` or `x-nestrix-key: <key>`, compared in constant time. With neither keys nor the opt-out set, ingest answers 401 and a start-up log line says how to configure it. The example apps then need one variable, `OTEL_EXPORTER_OTLP_ENDPOINT`, with the compose file setting `NESTRIX_INGEST_AUTH=none` (acceptance: "one environment variable in each example app").
- **Receiver:** `application/x-protobuf` and `application/json`; `Content-Encoding: gzip` (and `identity`); 64 MiB limit applied to the compressed body and, separately, to the decompressed size (a gzip bomb is cut off while inflating, 413); malformed body 400; invalid spans (bad id lengths, end before start) rejected individually and reported through `partial_success`; `IngestBusyError` → 503 with `Retry-After`; over a per-key token bucket → 429 with `Retry-After`. Protobuf decoding with `@bufbuild/protobuf` and code generated from a pinned `opentelemetry-proto` tag, checked in under `src/proto/gen/` with the generation script; OTLP JSON has its own mapping (hex ids, string-encoded 64-bit integers, enum names or numbers, camelCase per the OTLP JSON spec). Responses use the request's content type.
- **Self-tracing:** the server imports `NestrixModule.forRoot({ ui: false, ignore: { routes: ['/v1/traces'] } })`, so with `OTEL_EXPORTER_OTLP_ENDPOINT` unset it traces nothing outward, and it never traces its own ingest route.
- **Storage** (PostgreSQL 18, Drizzle 0.45 for queries and schema types, hand-written SQL migrations for partition DDL, applied at start under an advisory lock): `resources` (hash-deduplicated attributes, `service_name`, `service_version`), `spans` partitioned by day on start time (ids as text, times as `bigint` nanoseconds plus a `timestamptz` partition key, attributes/events/links as `jsonb`, extracted columns `service_name`, `http_route`, `http_method`, `http_status`, `is_root`, `is_error`, `trace_type`, `user_id`), `traces` (one summary row per trace, upserted at ingest with its root's fields, span count, services and span names: the trace list reads it; root rule in `src/storage/traces.ts`), `services` (names and last seen, for `MetaResponse.services`), `route_minutes` (per minute of the span's end, service, method, route: count, errors, total and max, a 30-bucket latency histogram with the embedded route statistics' bounds; `src/storage/histogram.ts` estimates percentiles) written at ingest for every HTTP server span (kind server with `http.request.method`: each service's entry span, since OTLP does not say whether a parent is remote), `class_minutes` likewise for method spans (`nestrix.class`/`nestrix.method`; these are post-sampling here, and the UI says so). Rollups and summaries count only newly inserted spans, so a retried export is not counted twice. Partitions created for today and the next two days at start and daily; retention drops partitions older than `NESTRIX_RETENTION_DAYS`.
- **Query API**: every embedded route plus `service` as an optional filter on lists and statistics, `MetaResponse.services` (names seen in the window) and a `mode: 'embedded' | 'standalone'` field. The map across services (D-56): nodes per service plus each service's external targets; an edge from service A to B for every client/producer span in A whose child server/consumer span is in B.
- **Admin login:** `/login` serves a small server-rendered form (no inline script; the page has a strict CSP), `POST /login` checks the password in constant time, rate-limited per IP (5 per minute), and sets an HttpOnly, `SameSite=Strict` session cookie (`Secure` unless the request is loopback plain HTTP) signed with HMAC; `POST` checks `Origin`. The query API and UI require the session; the API never emits CORS headers. `/logout` clears it.

## Tasks

### P5-01 Bootstrap, configuration, receiver

Owns `apps/server/src/{main.ts,app.module.ts,config.ts}`, `src/ingest/**` (except `model.ts`, which it may extend compatibly), `src/proto/**`, `scripts/` for generation, and tests under `apps/server/test/ingest/**`. Uses an in-memory `IngestSink` in tests. Recorded payload tests: protobuf and JSON, gzip, partial success, a gzip bomb, an oversized body, wrong content type, bad auth, 503 and 429 paths. A small fixture generator using the official OTLP exporter (devDependency) to record real payloads.

### P5-02 Storage

Owns `apps/server/src/storage/**`, `apps/server/migrations/**`, tests under `apps/server/test/storage/**`. Implements `IngestSink` (batched multi-row inserts, a bounded queue that raises `IngestBusyError`), partition management, retention (test: partitions older than the age are dropped), rollups. Tests against a Postgres 18 container.

### P5-03 Query API over Postgres

Owns `apps/server/src/query/**`, its tests, and the protocol additions (`service` params, `MetaResponse.services`, `mode`), keeping `@nestrix/nestjs`'s mirror, drift checks and API spec copies green (the embedded store accepts `service` and filters by its own name).

### P5-04 UI hosting and admin login

Owns `apps/server/src/ui/**`, `src/auth/**`, their tests. Serves `@nestrix/ui`'s files by its manifest (as `packages/nestjs/src/dashboard/assets.ts` does), with the dashboard's CSP.

### P5-05 UI for several services

Owns UI changes: a service selector in the shell when `meta.services` has more than one name (passes `service` to every query), the map view drawing services and the edges between them.

### P5-06 Docker, compose, end to end

`apps/server/Dockerfile` (multi-stage, `node:26-slim`, non-root), `apps/server/docker-compose.yml` (Postgres 18 + server), an end-to-end test that runs the compose stack, starts two example services with only `OTEL_EXPORTER_OTLP_ENDPOINT` set, sends a request through both, and finds one cross-service trace through the query API; a retention test. A short (60 s) ingest measurement with the official exporter as load, written to `benchmarks/results/server-ingest.md` as preliminary (the full benchmark is deferred).

### P5-08 Documentation and report

`apps/server/README.md` (run, configure, upgrade, the supported envelope as measured), architecture §4.10 in line, `docs/phase-5-report.md`.
