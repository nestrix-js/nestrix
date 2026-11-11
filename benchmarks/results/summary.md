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

Startup (spawn to first 200 on /hello, median): baseline 286.3 ms, noexport 329 ms, sink 504.8 ms, unreachable 334.2 ms, blackhole 524.4 ms, upstream 726.3 ms.

# Startup time

darwin-arm64, Node v26.13.0. Time from spawn to the first 200 on `GET /hello`, 15 fresh processes per configuration (interleaved, after one discarded warm-up round). "Added" is the median minus the uninstrumented median. The exporting configurations point at a local sink and do not wait for it; export is asynchronous.

| config | median ms | min ms | max ms | added vs baseline ms |
| --- | --- | --- | --- | --- |
| baseline | 281.7 | 253.8 | 310.6 |  |
| noexport | 338.6 | 298.1 | 493.6 | 56.9 |
| sink | 344.2 | 304.4 | 431.5 | 62.5 |

# Exporter outage

darwin-arm64, Node v26.13.0. 600 s of load at 3000 requests/s (open rate, 64 connections) over /hello, /users/42, /spans, /spans; RSS sampled every 5 s; growth is measured from the first sample at or after 60 s to the peak after it. Queue defaults: maxQueueSize 2048, maxExportBatchSize 512.

| config | req/s | p50 ms | p99 ms | RSS at 60 s MB | RSS peak after MB | growth MB | spans exported / failed / dropped |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sink | 2997.2 | 1.92 | 6.04 | 193.8 | 214.5 | 20.7 | 2699776 / 0 / 0 |
| unreachable | 2996.9 | 1.83 | 5.75 | 233.8 | 299.8 | 66 | 0 / 1422336 / 1262816 |
| blackhole | 2996.9 | 1.84 | 5.19 | 194.5 | 221 | 26.5 | 0 / 224768 / 2471136 |

## RSS bound

`(maxQueueSize + maxExportBatchSize) * heapBytesPerSpan + maxExportBatchSize * wireBytesPerSpan + rssNoiseMb`

- heapBytesPerSpan = 865.3 B, the marginal retained heap per queued span (heap after GC with a blackholed queue of 2048 against 20480 spans, median of 3 runs each; both queues overflowed: dropped {"2048":169349,"20480":566303}).
- wireBytesPerSpan = 354.9 B, from the control run's sink (OTLP/JSON bytes received per span).
- rssNoiseMb = 20.7 MB, the control run's own RSS growth after 60 s, with no outage.
- bound = 23 MB.

## Verdict

- unreachable: RSS growth 66 MB against a bound of 23 MB (EXCEEDED); p99 5.75 ms is 0.952x the control's 6.04 ms (within 5%). **FAIL**
- blackhole: RSS growth 26.5 MB against a bound of 23 MB (EXCEEDED); p99 5.19 ms is 0.859x the control's 6.04 ms (within 5%). **FAIL**

Notes: latency is recorded per response at 10 us resolution; with a fixed request rate it is not corrected for coordinated omission. Until HTTP server spans exist (P1-06) the only spans are the three `withSpan` spans of `/spans`.

## Diagnostics computed afterwards (not part of the pass criteria)

Added after the verdict above was produced, from the saved RSS samples in `outage.json` (least-squares slope of RSS over the samples at or after 60 s, and the mean of the last third of those samples minus the mean of the first third):

| config | RSS trend MB/min | last third - first third MB | mean RSS after 60 s MB |
| --- | --- | --- | --- |
| sink (control) | 0.68 | 5.7 | 193.0 |
| unreachable | 3.96 | 24.2 | 248.1 |
| blackhole | 0.92 | 6.6 | 196.8 |

The verdicts above stand as produced. Two things the numbers say about them. The growth metric (peak sample minus one sample) is itself noisy: the healthy control scores 20.7 MB on it, and the bound is mostly that noise term (the queue term is 2.2 MB). And the `unreachable` run sits on a higher RSS plateau than the control, with a visible upward drift in RSS over the run. `outage-diagnose.md` is a second 600 s run of `sink` and `unreachable` with a forced GC at every sample: for `unreachable` the heap after GC settles at about 44 MB against about 23 MB for the healthy sink, flat from 80 s on (trend 0.17 MB/min). So the drift in RSS is allocator and GC slack on top of a retained heap that is bounded but larger than the queue-derived prediction, not growth in retained heap.

# Install size

`pnpm pack` of @nestrix/nestjs, installed with `npm install --omit=dev` into a fresh directory (darwin-arm64, Node v26.13.0, npm 11.20.0). Sizes are `du -sk` (disk blocks, KiB).

- Tarball: 44 KiB; unpacked package: 264 KiB.
- Host stack alone (@nestjs/common, core, platform-express, reflect-metadata, rxjs): 21656 KiB (21.1 MB).
- Host stack plus @nestrix/nestjs: 41272 KiB (40.3 MB).
- **Added by Nestrix: 19616 KiB (19.2 MB)**, of which packages not in the host stack sum to 19608 KiB.
- Peer dependencies the host must supply (@opentelemetry/api) are among the added packages when the host does not already have them.

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
| @nestrix/nestjs | 0.0.0 | 264 KiB |
| @opentelemetry/exporter-trace-otlp-http | 0.301.1 | 156 KiB |
| @opentelemetry/context-async-hooks | 3.1.1 | 120 KiB |

Top-level packages with a different size once Nestrix is installed (shared dependencies resolved differently): none (KiB delta).
