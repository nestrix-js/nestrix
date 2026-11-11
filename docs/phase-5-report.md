# Phase 5 report: standalone server (0.4)

Date: 2026-11-11. Written by the lead under delivery mode (no approval stops; functional checks, local only; long benchmarks deferred).

## 1. Summary

Several services can now send OTLP to one self-hosted Nestrix. `apps/server` (`@nestrix/server`, private, shipped as a Docker image) is a NestJS 12 app with an OTLP/HTTP trace receiver, PostgreSQL 18 storage through Drizzle with day partitions and retention, the same query API and dashboard as the embedded mode (plus a service filter and a map across services), an admin login, a Dockerfile and a `docker compose` file. The receiver and the login were independently security-reviewed; both reviews found real defects (a 64 KB request that crashed the server; a login rate limit that IPv6 address rotation bypassed), all fixed.

## 2. Acceptance criteria (roadmap, phase 5)

| Criterion | Result | Evidence |
|---|---|---|
| `docker compose up` plus one environment variable in each example app gives a cross-service trace in the standalone UI | **Met** | `apps/server/test/e2e/docker.test.ts` (opt-in, `NESTRIX_E2E_DOCKER=1`): builds the image, starts compose, runs two example services with only `OTEL_EXPORTER_OTLP_ENDPOINT`, logs in, finds one trace with B's server span under A's client span, both services in `meta`, the service-to-service edge in `map`. |
| An ingest benchmark establishes the sustained spans per second the default Postgres setup handles; published as the supported envelope | **Partly met (preliminary)** | `benchmarks/results/server-ingest.md`: about 20,000 spans/s sustained, saturating near 22,000, on macOS with Docker in a 7.7 GiB VM and the load generator on the same host. The full benchmark on representative hardware is deferred (delivery mode). |
| Retention drops partitions older than the configured age | **Met** | `apps/server/test/storage/partitions.test.ts` ("retention drops partitions (and their rows) older than the retention, keeps the rest"), real Postgres. |

Validation: receiver tests with recorded payloads from the official exporters (protobuf and JSON, gzip, partial success) in `apps/server/test/ingest/`; the hardening tests (`hardening.test.ts`) for the review's attacks.

## 3. What was done

| Task | Result |
|---|---|
| P5-00 | Backlog, skeleton, ingest model. |
| P5-01 | Bootstrap, configuration, receiver. Review fixes: object-count walk before decoding (protobuf wire walk; JSON token count), 20 MiB body limit, process-wide memory budget (503) and per-request caps (413), unknown protobuf fields skipped, end times bounded to `int8` and one day ahead, slow-client timeouts and connection cap, per-span string and count caps. |
| P5-02 | Storage: migrations under an advisory lock, `spans`/`traces`/rollups partitioned by day, idempotent ingest (retries not double-counted), resource dedup, bounded writer queue, retention. |
| P5-03 | Query API over Postgres for every embedded route plus `service`, `meta.services`, `mode`, cross-service map. |
| P5-04 | UI hosting and admin login: deny-by-default middleware plus a global guard; HMAC session cookie with a per-process key and per-port name; Origin checks on writes; no CORS headers. Review fixes: rate limit never forgets live clients, global failure budget. |
| P5-05 | UI for several services: service selector, layered map, sign-out. |
| P5-06 | Dockerfile (`node:26-slim`, non-root, 520 MB), compose, end-to-end test, preliminary ingest measurement. |
| P5-07 | Security reviews of P5-01 and P5-04. |
| P5-08 | Server README, architecture §4.10, docs-site page. |

## 4. Runtime dependencies of `apps/server` (private package)

`@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@nestrix/nestjs`, `@nestrix/ui`, `@opentelemetry/api`, `reflect-metadata`, `rxjs` (the Nest app); `@bufbuild/protobuf` (OTLP protobuf decoding, as architecture §4.10 specifies); `drizzle-orm` and `pg` (storage, D-16).

## 5. Deferred and known limits

- The full ingest benchmark on representative hardware; latency figures under load.
- Only `/v1/traces` is accepted; logs and metrics go to a collector.
- `/trace` carries a service per span now (`SpanRecord.service`, D-69), but the trace view only shows it in the span detail.
- A login over plain HTTP to a non-loopback host loops (the cookie is `Secure`); put the server behind TLS. Restarting signs everyone out.
- The 60-failures-per-minute login budget lets an attacker lock the admin out for up to a minute.
