> The dashboard's cost (store processor, route statistics), the store's bytes per trace and default limits, and the lazy OTLP exporter's saving (P2-12, P2-14) are in `dashboard.md`; its throughput numbers include HTTP server spans and are not comparable with the table below.

> **Throughput and latency below were measured before HTTP server spans existed** (earlier in P1-13, with `noexport`/`sink`/... only creating the `withSpan` spans of `/spans`). They are not re-run and do not show the cost of HTTP server spans. Startup, install size and the outage run below are from current main (HTTP server spans, outbound spans, single-flight export).

# Throughput and latency

darwin-arm64, Node v26.13.0, 3 fresh-process run(s) per configuration, 10 s per route after 2 s warmup, 64 connections (closed loop). Values are medians across runs. Load generator, app and sink are separate processes on one machine. Delta is throughput against the uninstrumented run of the same route.

| config | route | p50 ms | p99 ms | req/s | vs baseline | CPU % of one core | RSS MB | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | GET /hello | 1.45 | 3.08 | 41052 | 0% | 98.3 | 149.5 | 0 |
| baseline | GET /users/:id | 1.55 | 3.26 | 38781 | 0% | 97.8 | 156 | 0 |
| noexport | GET /hello | 1.4 | 3.01 | 42214 | 2.8% | 97.6 | 225.8 | 0 |
| noexport | GET /users/:id | 1.55 | 3.18 | 38843 | 0.2% | 98.4 | 233.6 | 0 |
| noexport | GET /spans (3 manual spans) | 1.81 | 3.69 | 33641 |  | 101.9 | 229.6 | 0 |
| sink | GET /hello | 1.5 | 2.98 | 41351 | 0.7% | 98.8 | 232.7 | 0 |
| sink | GET /users/:id | 1.61 | 3.23 | 38219 | -1.4% | 98.1 | 238 | 0 |
| sink | GET /spans (3 manual spans) | 2.09 | 4.14 | 28656 |  | 103.8 | 242.2 | 0 |
| unreachable | GET /hello | 1.44 | 2.94 | 42121 | 2.6% | 98.7 | 237 | 0 |
| unreachable | GET /users/:id | 1.56 | 3.2 | 38919 | 0.4% | 98.5 | 245.9 | 0 |
| unreachable | GET /spans (3 manual spans) | 1.83 | 3.78 | 32566 |  | 101.8 | 250.1 | 0 |
| blackhole | GET /hello | 1.45 | 3.16 | 40686 | -0.9% | 97.4 | 236 | 0 |
| blackhole | GET /users/:id | 1.58 | 3.31 | 37767 | -2.6% | 95.8 | 243.9 | 0 |
| blackhole | GET /spans (3 manual spans) | 1.86 | 4.29 | 31462 |  | 100.3 | 235.6 | 0 |
| upstream | GET /hello | 3.71 | 6.71 | 17492 | -57.4% | 109.2 | 297.2 | 0 |
| upstream | GET /users/:id | 3.88 | 7.01 | 16395 | -57.7% | 108.2 | 314.2 | 0 |



darwin-arm64, Node v26.13.0. Time from spawn to the first 200 on `GET /hello`, 15 fresh processes per configuration (interleaved, after one discarded warm-up round). "Added" is the median minus the uninstrumented median. The exporting configurations point at a local sink and do not wait for it; export is asynchronous.

| config | median ms | min ms | max ms | added vs baseline ms |
| --- | --- | --- | --- | --- |
| baseline | 268.8 | 261.2 | 291.4 |  |
| noexport | 320.3 | 309.7 | 383.1 | 51.5 |
| sink | 318.8 | 310 | 371.9 | 50 |

## Install size

`pnpm pack` of @nestrix-js/nestjs, installed with `npm install --omit=dev` into a fresh directory (darwin-arm64, Node v26.13.0, npm 11.20.0). Sizes are `du -sk` (disk blocks, KiB).

- Tarball: 88 KiB; unpacked package: 500 KiB.
- Host stack alone (@nestjs/common, core, platform-express, reflect-metadata, rxjs): 21656 KiB (21.1 MB).
- Host stack plus @nestrix-js/nestjs: 41508 KiB (40.5 MB).
- **Added by Nestrix: 19852 KiB (19.4 MB)**, of which packages not in the host stack sum to 19844 KiB.
- `@opentelemetry/api`, a peer dependency, is counted among the added packages because the host stack above does not include it.

Packages added, largest first:

| package | version | size |
| --- | --- | --- |
| @opentelemetry/semantic-conventions | 1.45.0 | 9824 KiB |
| @opentelemetry/api | 1.10.0 | 1932 KiB |
| @opentelemetry/sdk-metrics | 3.1.1 | 1612 KiB |
| @opentelemetry/otlp-transformer | 0.301.1 | 1084 KiB |
| @opentelemetry/sdk-trace | 3.1.1 | 1056 KiB |
| @opentelemetry/core | 3.1.1 | 1048 KiB |
| @opentelemetry/otlp-exporter-base | 0.301.1 | 932 KiB |
| @opentelemetry/resources | 3.1.1 | 880 KiB |
| @opentelemetry/sdk-logs | 3.1.1 | 700 KiB |
| @nestrix-js/nestjs | 0.0.0 | 500 KiB |
| @opentelemetry/exporter-trace-otlp-http | 0.301.1 | 156 KiB |
| @opentelemetry/context-async-hooks | 3.1.1 | 120 KiB |

Top-level packages with a different size once Nestrix is installed (shared dependencies resolved differently): none (KiB delta).

## Exporter outage

darwin-arm64, Node v26.13.0. 600 s of load at 3000 requests/s (open rate, 64 connections) over /hello, /users/42, /spans, /spans. Queue defaults: maxQueueSize 2048, maxExportBatchSize 512. The app runs with `--expose-gc` and a forced GC precedes every heap sample (every 5 s); medians and slopes use the samples from 60 s to the end.

| config | req/s | p50 ms | p99 ms | median heap after GC MB | heap slope MB/min | median RSS MB | RSS slope MB/min | max client connections | max connections at sink | spans exported / failed / dropped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sink | 2996.7 | 3.78 | 12.93 | 23.8 | 0.03 | 220.9 | 0.14 | 1 | 1 | 4499968 / 0 / 0 |
| unreachable | 2996.6 | 3.17 | 9.12 | 26.2 | 0.01 | 206.9 | 0.67 | 2 | n/a | 0 / 37376 / 4460138 |
| blackhole | 2996.2 | 3.18 | 8.95 | 26 | 0.03 | 207.1 | 0.32 | 2 | 5 | 0 / 30720 / 4467239 |

### Allowance

`(maxQueueSize + 2 * maxExportBatchSize) * B_span + maxExportBatchSize * B_wire + 5 MB` = 8.07 MB.

- B_span = 946.2 B retained heap per queued span (re-measured in this run).
- B_wire = 610.7 B of OTLP/JSON per span (re-measured at this run's control sink).
- Client connections are counted inside the app from the `net.client.socket` diagnostics channel (created until `close`, idle keep-alive sockets included). For `unreachable` there is no server, so this is the only count; a refused attempt lives for well under a millisecond, so the sampling is exact (every socket is observed) but the maximum is of sockets alive at once, not of attempts per second.

### Verdict

### unreachable: **PASS**

1. Heap plateau: median heap-after-GC is 2.4 MB above the control's 23.8 MB; allowance 8.07 MB. pass
2. Heap trend: slope 0.01 MB/min; limit < 0.5. pass
3. RSS trend: slope 0.67 MB/min against the control's 0.14 + 1 = 1.14. pass
4. Connections: at most 2 open at once before shutdown (369 created in total; the sink saw at most n/a at once); limit 2. pass
5. p99 9.12 ms is 0.705x the control's 12.93 ms; limit 1.05. pass

### blackhole: **PASS**

1. Heap plateau: median heap-after-GC is 2.2 MB above the control's 23.8 MB; allowance 8.07 MB. pass
2. Heap trend: slope 0.03 MB/min; limit < 0.5. pass
3. RSS trend: slope 0.32 MB/min against the control's 0.14 + 1 = 1.14. pass
4. Connections: at most 2 open at once before shutdown (61 created in total; the sink saw at most 5 at once); limit 2. pass
5. p99 8.95 ms is 0.692x the control's 12.93 ms; limit 1.05. pass

### Informational: the old metric (not a criterion)

Peak RSS after 60 s minus RSS at 60 s. Allocator steps dominate it; the control has no outage and scores on it too.

| config | RSS at 60 s MB | RSS peak after MB | growth MB | last third - first third MB |
| --- | --- | --- | --- | --- |
| sink | 212 | 230.1 | 18.1 | 2.2 |
| unreachable | 202.3 | 219.4 | 17.1 | 3.5 |
| blackhole | 206.3 | 215.9 | 9.6 | 1.9 |

Notes: latency is recorded per response at 10 us resolution; with a fixed request rate it is not corrected for coordinated omission. The forced GC every 5 s is the same in every run, so it does not bias the p99 comparison.
