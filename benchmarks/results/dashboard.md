# Dashboard cost and store limits (P2-12, P2-14)

darwin-arm64, Node v26.13.0, 2026-11-11. One machine, nothing else running: no other benchmark and no test suite at the same time. The dashboard UI was **not open** during any run (its polling would add requests), so these numbers cover the store processor and route statistics only, not the dashboard's API handlers.

Raw results sit next to this file: `store-bytes.json|md`, `dashboard-passA.json|md`, `dashboard-passB.json|md`, `dashboard-memory*.json|md`, `dashboard-micro.json|md`, `startup-dashboard.json|md`.

## Commands

```bash
pnpm build
cd benchmarks
node src/store-bytes.mjs                                                       # 1. bytes per trace
node src/throughput.mjs --configs=headless,dashboard --duration=5 --runs=2 --name=dashboard-passA   # 3.
node src/throughput.mjs --configs=dashboard,headless --duration=5 --runs=2 --name=dashboard-passB   #    (reverse order)
node src/dashboard-memory.mjs                                                  # live heap vs RSS
node src/dashboard-micro.mjs                                                   # ns per call, no HTTP
node src/startup.mjs --configs=baseline,headless,headless-eager,dashboard --repeats=20 --name=startup-dashboard   # 4.
for i in 1 2 3; do node src/dashboard-memory.mjs --configs=headless,headless-eager,dashboard --duration=3 --name=dashboard-memory-$i; done
```

Configurations (`src/lib.mjs`, `src/app.mjs`): `headless` is `NestrixModule.forRoot({ ui: false })`; `dashboard` is `forRoot({ ui: 'auto' })` with `NODE_ENV=development`. Neither exports. The app is the same Express app as the earlier benchmarks (`/hello`, `/users/:id`, and `/spans`, which adds three manual spans). Closed-loop load, 64 connections, autocannon in the parent.

## 1. Bytes per stored trace

Heap growth after a forced GC (twice) per stored trace, limits raised so nothing is evicted; spans go through a real SDK 3 provider and the built store processor; median of 3 fresh-process runs. The estimate is the store's `stats().bytes`, the number `maxBytes` is checked against.

| shape | spans/trace | heap B/trace | estimate B/trace | estimate / heap |
| --- | --- | --- | --- | --- |
| 1: server span only | 1 | 1,358 | 1,523 | 1.12 |
| 2: server + 5 client spans | 6 | 3,972 | 4,852 | 1.22 |
| 3: server + 50 spans (51 total), attributes, an exception event with a 13-line stack | 51 | 27,798 | 31,846 | 1.15 |

The estimate stays a moderate over-estimate (1.12x to 1.22x), as `store-bytes.test.ts` requires. Values are fresh heap strings, as parsed request values are in a real app. Run-to-run spread was under 0.1% in bytes per trace (heap growth is deterministic here).

## 2. Defaults

`maxTraces` 5,000 (was 1,000), `maxBytes` 32 MiB (unchanged), in `packages/nestjs/src/store/limits.ts` and `src/resolve-options.ts`.

Each shape fed through a store with these limits until it evicts (heap growth after a forced GC, from before any trace):

| shape | traces fed | stored | evicted | estimate MiB | real heap MiB |
| --- | --- | --- | --- | --- | --- |
| 1: server span only | 20,200 | 5,000 | 15,200 | 7.3 | 7.0 |
| 2: server + 5 client spans | 20,200 | 5,000 | 15,200 | 23.2 | 19.5 |
| 3: 51 spans | 3,200 | 1,052 | 2,148 | 32.0 | 28.1 |

Reasoning: typical traces (shape 2) reach `maxTraces` first, at 19.5 MiB of real heap, under the 32 MiB target; heavy traces (shape 3) reach `maxBytes` first, at about 1,050 traces and 28 MiB real; the estimate is 1.12x to 1.22x the heap, so 32 MiB of estimate is always at most about 28 MiB of heap. The old 1,000 traces would have held only 3.9 MiB of typical traces, so a busy service would have listed a few seconds of traffic.

## 3. Headless against dashboard

Two passes, in opposite order, 2 fresh-process runs per configuration per pass, 5 s per route after 2 s warmup. Medians of the 4 runs. Total 2 x 73 s.

| route | config | p50 ms | p99 ms | req/s | RSS MB |
| --- | --- | --- | --- | --- | --- |
| GET /hello | headless | 2.185 | 4.335 | 27,984 | 277 |
| GET /hello | dashboard | 2.605 | 3.735 | 23,794 | 326 |
| GET /users/:id | headless | 2.280 | 4.525 | 26,897 | 230 |
| GET /users/:id | dashboard | 2.710 | 3.835 | 22,948 | 292 |
| GET /spans (3 manual spans) | headless | 2.425 | 4.810 | 25,219 | 273 |
| GET /spans (3 manual spans) | dashboard | 3.080 | 4.515 | 19,978 | 341 |

Cost of the dashboard being on, per request (difference of `1 / throughput`, the app saturating one core):

| route | throughput | wall cost per request |
| --- | --- | --- |
| GET /hello (1 server span) | -15.0% | **6.3 us** |
| GET /users/:id (1 server span) | -14.7% | **6.4 us** |
| GET /spans (server span + 3 manual) | -20.8% | **10.4 us** |

Reading it:

- The two passes agree within about 1% on every number (4 runs per cell, throughput spread under 2%), so these are not noisy. The percentages look large because the uninstrumented-plus-HTTP-spans request here costs only about 36 us; against any real handler (a database call is 1000 us or more) 6 us is under 1%.
- p50 rises by 0.42 to 0.66 ms because the load is closed-loop with 64 connections (latency is about 64 / throughput). **p99 is lower with the dashboard** (3.7 against 4.3 ms). That is a closed-loop artefact (fewer requests per second, so a lower arrival rate at the app), not a benefit; do not quote it.
- RSS under saturating load is 48 to 68 MB higher with the dashboard. The live heap is not: see below.
- The split between the store processor and route statistics was measured without HTTP (`dashboard-micro`): `RouteStatistics.record()` is **68 ns** per request; the store processor costs **7.2 us per span** (an SDK span costs 1.5 us without it). So route statistics are about 1% of the 6.3 us and the store processor is essentially all of it. These two figures were measured separately from the 6.3 us and agree with it (7.2 us for the one server span against 6.3 us end to end).
- `/spans` costs 10.4 us for 4 spans, not 4 x 6.3 or 4 x 7.2: the extra spans of a trace cost about 1.4 us each in the end-to-end run, against 7.2 us in the micro-benchmark. Not explained; the micro-benchmark uses one-span traces, where each span also creates a trace entry and evicts one at the limit.

### Memory

`dashboard-memory`: one fresh process each (`--expose-gc`), 5 s of load on `/users/42`, then a forced GC; store at its default limits and full (5,000 traces).

| config | idle RSS MB | idle heap MB | RSS after load MB | heap after load + GC MB | heap total MB |
| --- | --- | --- | --- | --- | --- |
| headless | 125.3 | 21.3 | 252.6 | 21.5 | 89.8 |
| dashboard | 125.6 | 21.5 | 323.6 | 32.0 | 152.5 |

Live heap after GC is **10.5 MB** higher with the dashboard (the full store holds 6.5 MB by estimate for these one-span traces, so the rest is route statistics, the pending queue and the evicted-entry churn not yet compacted; not split further). The RSS gap under load (about 50 to 70 MB) is mostly heap the V8 has grown and not given back (heap total 152 against 90 MB). That the dashboard's higher allocation rate (a record copied per span) causes the larger reserved heap is an inference from the figures, not tested. Idle RSS is the same.

### After P2-15 (store eviction and per-request allocation)

The numbers above are as measured for P2-12. P2-15 found that the store's oldest-trace lookup (`Map.values().next()`) scanned deleted slots and was 40% of the store's CPU time; it and a few allocation reductions are in `allocation.md`, with the method. Re-measured the same day, one pass of the same command (`dashboard-after.md`):

| route | headless req/s | dashboard req/s | throughput cost of the dashboard | wall cost per request |
| --- | --- | --- | --- | --- |
| GET /hello (1 server span) | 28,166 | 25,721 | -8.7% (was -15.0%) | **3.4 us** (was 6.3) |
| GET /users/:id (1 server span) | 27,170 | 24,875 | -8.5% (was -14.7%) | **3.4 us** (was 6.4) |
| GET /spans (server span + 3 manual) | 25,406 | 22,550 | -11.2% (was -20.8%) | **5.0 us** (was 10.4) |

`dashboard-micro` now reports the store processor at **1.9 us per span** (was 7.2 us; the before run is `micro-before.md`) and `RouteStatistics.record()` at 70 ns. In the bullets above, read "7.2 us per span" as the figure before P2-15, and the unexplained `/spans` note as explained there: the eviction scan cost was per new trace, so extra spans of a trace were cheap. Bytes per trace, the defaults and the memory table were not re-measured and are unaffected (the stored records and byte estimates are identical).

## 4. P2-14: OTLP exporter loaded lazily, export off

`headless-eager` is `headless` plus an import of `@opentelemetry/exporter-trace-otlp-http` (its ESM entry, as the pipeline's dynamic import resolves it) at the start of `app.mjs`. That is what the pipeline did before P2-14. No source file was reverted.

Startup (spawn to first 200 on `/hello`), 20 fresh processes per configuration, interleaved:

| config | median ms | min ms | max ms | added vs baseline ms |
| --- | --- | --- | --- | --- |
| baseline | 246.1 | 238.9 | 248.9 | |
| headless (lazy exporter, after P2-14) | 278.8 | 271.1 | 305.3 | 32.7 |
| headless-eager (before P2-14) | 295.2 | 288.6 | 300.8 | 49.1 |
| dashboard (lazy exporter, dashboard on) | 282.9 | 272.0 | 288.8 | 36.8 |

**The lazy exporter saves 16.4 ms of startup (median) with export off** (the ranges do not overlap), and the dashboard adds 4.1 ms on top of headless.

Memory, 3 fresh processes per configuration (`dashboard-memory-1..3`), idle after startup:

| config | idle heap MB (all 3 runs) | idle RSS MB (3 runs) | median |
| --- | --- | --- | --- |
| headless (lazy) | 21.3, 21.3, 21.3 | 125.4, 119.6, 120.3 | 120.3 |
| headless-eager | 22.4, 22.4, 22.4 | 126.0, 127.0, 126.2 | 126.2 |

The heap saving is **1.1 MB, identical in all three runs** (verified). The idle RSS saving is about **6 MB** (median of 3), but idle RSS varied by 5 MB within a configuration, so treat it as roughly 6 MB plus or minus 3, not a precise figure. RSS after load was too noisy to compare (headless 244 to 277 MB across runs, eager 251 to 275 MB).

## What this does not cover

- The dashboard UI open and polling; the dashboard API's handlers; a store with many error items.
- Real traces: the shapes are synthetic but built with realistic attribute sets; real apps with larger attribute values (a long SQL text, large headers in the allow-list) cost more per trace, which is what `maxBytes` is for.
- Other machines. Absolute throughput is lower here than in `throughput.md`, because this run includes HTTP server spans and the earlier one was taken before they existed (see the note in `summary.md`).
- A long soak. None was run (out of scope for P2-12).
