# Standalone server ingest (preliminary)

**Preliminary.** A short measurement for the phase 5 acceptance criteria (P5-06), not the benchmark. The full benchmark (longer runs, several machines, steady-state and soak, tuned Postgres) is deferred. Do not quote these numbers as a guarantee.

## Setup

- Machine: macOS (Darwin 25.6, Apple silicon) running Docker in a VM with 7.7 GiB of memory. Load generator and server on the same host, so they share CPUs.
- Stack: `apps/server/docker-compose.yml` (`postgres:18` with default settings, server image built from `apps/server/Dockerfile`, `NESTRIX_INGEST_AUTH=none`), Node 26.13.0.
- Load: `apps/server/scripts/ingest-load.mjs`. The official OTLP/HTTP protobuf exporter (`@opentelemetry/exporter-trace-otlp-proto` 0.301.1) with the SDK 3.1.1 `BatchSpanProcessor` (batches of 2048, flush every 1 s), 4 tracer providers (4 service names) in one process, uncompressed. One trace is a server span plus two client spans (3 spans, with the HTTP and database attributes the rollups use), so each batch also exercises `traces`, `route_minutes` and `services`.
- Stored counts: `select count(*) from spans` in the Postgres container, before and after (the delta), read a few seconds after the load stopped.

## Results

| run | target spans/s | load time | accepted by the server | stored | refused |
| --- | --- | --- | --- | --- | --- |
| paced | 20 000 | 45 s (46 s with the final flush) | 899 382 (19 447/s over 46 s) | 899 382 | 0 |
| saturated | 80 000 | 30 s (41 s with the final flush) | 886 784 (21 796/s over 41 s) | 886 784 | 666 953 |

- **Sustained, nothing refused: 20 000 spans/s** (899 382 spans, 440 export requests of about 2 000 spans, all accepted, all stored). The paced run met its target, so this is a lower bound, not a ceiling.
- **Saturation: about 22 000 spans/s accepted and stored** when the exporter offers 80 000. The rest is refused by the server (503/429 back-pressure; the exporter reports failure, it does not say which code) or dropped by the exporter's own queue (2 399 442 generated, 1 553 737 exported). Every accepted span was stored: accepted and stored counts are equal in both runs, and the second run's refusals show that back-pressure works instead of growing memory.
- **Resources** (`docker stats`, sampled every 8 s during the paced run; sampling pauses the load generator for a moment each time): server 4% to 9% of one core while ingesting, 250 to 310 MiB resident; Postgres 0.1% to 63% of a core (the peaks follow batch commits), 160 to 230 MiB. After the saturated run Postgres held 727 MiB. These are rough single samples.
- The server image is 520 MB (`node:26-slim` plus the production dependencies, including the dashboard assets).

## What this does not say

- One load generator on the same machine as the server and the database; a real deployment has network between them.
- Default Postgres settings, no tuning, no concurrent dashboard queries, spans with few attributes.
- The per-key rate limit (100 export requests per second, burst 200) was not the limit here (about 10 requests per second at about 2 000 spans each); it caps a single client at roughly 200 000 spans/s with full batches, and at 51 200 spans/s with the SDK's default batch of 512. It does not need an environment variable yet.
- No latency numbers were taken.
