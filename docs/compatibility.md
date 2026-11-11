# Compatibility

What Nestrix supports, and the test or CI job behind each claim. Three words are used, and only these:

- **Tested**: a test or CI job in this repository runs against that version, and the table names it.
- **Expected to work**: not run here; it follows from the design (for example, the same public API). Report a failure as a bug.
- **Not supported**: known not to work, or deliberately out of scope.

The CI jobs are defined in `.github/workflows/ci.yml` (`verify`, `consume`, `jaeger`, `e2e`) and `.github/workflows/nightly.yml` (`conformance-latest`, `latest-nest`). On 2026-11-11 the CI workflow passed on GitHub for `main` (run 43046693547: `verify`, `consume` esm and cjs, `jaeger`, `e2e`; an earlier run failed once in the `e2e` browser-install step and the next run passed). The nightly workflow has not run on GitHub yet (no run listed), so the "latest 12.x" rows rest on the newest Nest in the lockfile (12.4.2) until it does.

## Runtime

| | Status | Evidence |
|---|---|---|
| Node.js 26.13 and later | Tested (26.x, latest) | `engines` is `>=26.13.0` in both packages (D-55). `verify`, `consume` and `e2e` run one Node line, the latest 26.x. |
| Node.js 22 and 24 | Not supported | Dropped by D-55; `engines` declares it; whether an install is refused or only warned depends on the package manager's engine-strict setting. Not run on them. |
| Module format | ESM-only package | `check:tla` requires every built file from CommonJS; `consume (esm)` and `consume (cjs)` boot a fresh Nest 12 app in each format from packed tarballs. |
| CommonJS Nest 12 app | Tested | `consume (cjs)`; it loads the package with `require()` (no top-level `await` anywhere an entry point imports). |
| Bundlers, serverless runtimes, Deno, Bun | Expected to work at best | Not run. AWS Lambda's Node runtimes disable `require(esm)`; see the CommonJS notes in the README. |

## NestJS

| | Status | Evidence |
|---|---|---|
| `@nestjs/common`, `@nestjs/core` 12.0.0 | Tested | `packages/conformance-nest12-0` pins 12.0.0 and runs the shared conformance files (Express and Fastify); part of `verify`. |
| 12.3.2 | Tested | `packages/conformance-nest12-3-2` pins 12.3.2 and runs them on Express, Fastify and platform-node. |
| Latest 12.x (12.4.2 in the lockfile) | Tested | `packages/nestjs` itself, in `verify`; the nightly job (`conformance-latest`, `latest-nest`) updates `@nestjs/*` to the newest 12.x and re-runs the conformance suite and the whole `verify`. |
| Other 12.x between 12.0.0 and 12.4.2 | Expected to work | Same public APIs; the three versions above bracket them. |
| 11.x and earlier | Not supported | Peer range is `^12.0.0`; the request hook Nestrix uses is a Nest 12 API (`docs/nest-hooks.md`). |

### Adapters

| Adapter | Status | Evidence |
|---|---|---|
| `@nestjs/platform-express` (Express 5), from 12.0.0 | Tested | `conformance-http.test.ts`, `conformance-apps.test.ts`; dashboard in `e2e` and `dashboard-*.test.ts`. |
| `@nestjs/platform-fastify` (Fastify 5), from 12.0.0 | Tested | Same files. Header versioning with two versions of one route does not boot on Fastify with Nest 12.0.0 (Nest itself); the conformance suite skips that case on 12.0.0. |
| `@nestjs/platform-node`, from 12.3.2 | Tested on 12.3.2 and latest | `conformance-nest12-3-2`. Not supported on 12.3.0 and 12.3.1: the request context is lost after JSON body parsing (D-44, spike P0-S1). Known limit: `Content-Type` and `Content-Length` response headers are missing from server spans. |
| No HTTP adapter (pure microservice) | Tested | `conformance-apps.test.ts`; boots, handler spans only, no dashboard. |
| Several apps in one process | Tested | `conformance-apps.test.ts`. |
| `@nestjs/testing` | Tested | `http-testing.test.ts`, also run nightly: HTTP spans work; method spans are not applied. |
| Other HTTP adapters (custom, `@nestjs/platform-ws` as an HTTP server, GraphQL-only apps) | Not tested | Expected to work only where the adapter is one of the three above. |

### `@nestjs/microservices`

An optional peer. Message propagation needs 12.0.4 or later (`ClientProxy#setOnDispatchHook` and `PacketMetadata` are absent before it; `docs/research.md`). The declared peer range is `^12.0.4`, so a package manager warns on 12.0.0 to 12.0.3.

| | Status | Evidence |
|---|---|---|
| 12.4.x | Tested | `test/microservices/*.test.ts` (in `verify`). |
| 12.0.4 to 12.3.x | Expected to work | Conformance packages carry 12.0.0 and 12.3.2 of `@nestjs/microservices` but run no message tests; not run on 12.0.4. |
| 12.0.0 to 12.0.3 | Not supported | No dispatch hook. |

## OpenTelemetry

| | Status | Evidence |
|---|---|---|
| `@opentelemetry/api` 1.10 | Tested | Peer range `>=1.10.0 <1.11.0`; every test. A 1.9 host fails to install (`ERESOLVE`) on purpose, because a second API copy loses spans silently (D-40). |
| OpenTelemetry JS SDK 3 (`sdk-trace` 3.1, `context-async-hooks` 3.1) | Tested | Nestrix's own SDK setup, and a host-owned SDK 3 in `otel-host-provider.test.ts`, `dashboard-host-sdk.test.ts`, `store-host-sdk.test.ts`. |
| SDK 2.x | Not supported | D-40. |
| `sdk-metrics` 3.1 and `exporter-metrics-otlp-http` 0.301 | Tested (optional peers) | `test/metrics/*`. |
| `sdk-logs` 3.1 and `exporter-logs-otlp-http` 0.301 | Tested (optional peers) | `test/logs/*`. |
| Exporter protocol | OTLP/HTTP protobuf only | D-69 (5); `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_TRACES_SAMPLER*` and `OTEL_SDK_DISABLED` are not read in 1.x. |
| Jaeger as the OTLP receiver | Tested | CI job `jaeger` (two services, one trace). |

## Libraries and jobs

Container tests start the official images with Docker and skip with a message when Docker is not available. GitHub's `ubuntu-latest` has Docker, so `verify` runs them there.

| Library | Version tested | Status | Evidence |
|---|---|---|---|
| `pg` | 8.23.1 (peer `^8.0.0`), against `postgres:18-alpine` | Tested; on by default | `test/integrations/pg.test.ts`, `pg-absent.test.ts`. Other 8.x: expected to work. |
| `mysql2` | 3.24.6, against `mysql:8.4` | Tested; opt-in (`integrations.mysql2: true`) | `test/integrations/mysql2.test.ts`. 3.20 or later is needed (diagnostics channels). |
| `ioredis` | 6.0.0, against `redis:8-alpine` | Tested; opt-in | `test/integrations/ioredis.test.ts`. 5.11 or later is needed. |
| BullMQ | 6.7.2 with `bullmq-otel` 2.0.1 and `@nestjs/bullmq` 12.0.1, against `redis:8-alpine` | Tested | `test/e2e-phase3/jobs.test.ts`. |
| `@nestjs/schedule` | 12.0.3 | Tested | `test/methods`, `e2e-phase3`. |
| ORMs on `pg` (MikroORM and similar) | Not run here | Expected to work for a `pg` copy loaded at import time or in a provider factory; a copy first loaded during a request is not traced (documented). |
| Other drivers (`mongodb`, `mssql`, `better-sqlite3`, `postgres.js`) | Not tested | Not supported by Nestrix itself; upstream `@opentelemetry/instrumentation-*` packages use the same API and join the same traces. |
| `undici` 7, `node:http`, `fetch` | Tested | `test/outbound-*.test.ts`. |

## Microservice transports

All tested end to end against real brokers, as one connected trace across an HTTP request, a `send` and an `emit` (`test/microservices-e2e/*.test.ts`, brokers in `brokers.global.ts`; part of `verify`, skipped without Docker).

| Transport | Status | Broker and client |
|---|---|---|
| TCP | Tested | In process. |
| Redis | Tested | `redis:8-alpine`. |
| NATS | Tested | `nats:2`, `@nats-io/transport-node` 3.4. Servers without headers: not tested. |
| RabbitMQ | Tested | `rabbitmq:4`, `amqplib` 2.2. |
| Kafka | Tested | `apache/kafka:4.1.0`, `kafkajs` 2.2. `emitBatch` injects context but gets no span. |
| MQTT 5 | Tested | `eclipse-mosquitto:2`, `mqtt` 5.16. |
| MQTT 3 | Not supported for propagation | No header channel; handler spans start new traces. |
| gRPC | Not tested | No `send`/`emit`, no server-side `getMetadata()`; documented as untested (phase 4 report). |
| Custom transports | Traced, partial | Named `rpc <pattern>`, no `messaging.system`. |

## Dashboard

| | Status | Evidence |
|---|---|---|
| Chromium | Tested | CI job `e2e` (`e2e/`, Playwright 1.65, against built example apps with `NestrixModule`; fails on CSP violations and console errors). |
| Firefox | Tested locally only | `packages/ui/playwright.config.ts` has chromium and firefox projects (`pnpm --filter @nestrix-js/ui e2e`, against a mock API); not a CI job. |
| WebKit and Safari, Edge, mobile browsers | Not tested | Expected to work in current evergreen releases (the UI is a plain static bundle); no test runs them. |
| Layout | Desktop | No phone-width layout work was done. |

## Standalone server (`apps/server`)

The server is a private workspace app in 1.0, shipped as a Docker image built from the repository, not a published npm package.

| | Status | Evidence |
|---|---|---|
| PostgreSQL 18 | Tested | `apps/server/test/storage/global-setup.ts` runs `postgres:18-alpine`; `apps/server/docker-compose.yml` uses `postgres:18`. |
| PostgreSQL 17 and earlier | Not supported | Not run; the migrations were written and tested against 18. |
| Docker image | Tested | `node:26-slim` for both build and runtime stages; runs as the `node` user; the end-to-end test `apps/server/test/e2e/docker.test.ts` builds the image and runs two example services through `docker compose`, but is opt-in (`NESTRIX_E2E_DOCKER=1`), so it is not part of `pnpm verify` or CI. |
| Other base images (Alpine, distroless) | Not tested | |
| Senders | Any OTLP/HTTP protobuf exporter; Nestrix apps tested | `apps/server/test/ingest`, the docker end-to-end test. Other OTLP senders: expected to work, not run. |

## Optional packages

| Package | Needed for |
|---|---|
| `@nestrix-js/ui` (same version as `@nestrix-js/nestjs`) | the embedded dashboard |
| `@nestjs/microservices` | microservice spans |
| `pg` | `pg` spans (other drivers need no package from Nestrix) |
| `@opentelemetry/sdk-logs`, `@opentelemetry/exporter-logs-otlp-http` | `logs.export` |
| `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http` | metric export |
| `bullmq-otel` | BullMQ job traces |

## What is not covered

- No version matrix beyond the cells above: one Node line, three Nest versions, one version of each library. A second Node line or older library versions would repeat the same projects.
- No performance guarantees: benchmarks and soak runs were deferred (delivery mode) and are listed in the phase reports.
- Windows and macOS: CI runs on `ubuntu-latest`; development was done on macOS (darwin-arm64). Windows is not tested.
