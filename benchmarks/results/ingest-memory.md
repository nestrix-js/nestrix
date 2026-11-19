# Standalone server ingest memory (D-116)

What the OTLP receiver really holds against what its in-flight budget charges, before and after D-116 (the join of a multi-chunk body reserved before it is made, decoded strings added to the decode estimate). Short runs, one machine: a functional measurement, not a benchmark.

## Setup

- Machine: Apple M1 Pro, 10 cores, 32 GiB, macOS (Darwin 25.6). Host runs: Node v26.13.0. Container runs: Docker (colima VM), `ghcr.io/nestrix-js/nestrix-server:0.9.1` image used only for its Node v26.13.1 (linux/arm64), running this worktree's `apps/server/dist` mounted read-only.
- Harness: `src/ingest-memory.mjs` (load, PostgreSQL container) and `src/ingest-memory-server.mjs` (the server, `createApp` with PostgreSQL or `AppModule` with the memory sink, plus probes that only observe). Rate limit lifted, `NESTRIX_INGEST_AUTH=none`.
- Load: N raw-socket clients, each sending one profile back to back; every body is written in 4 KiB pieces with a macrotask between (thousands of server-side chunks per body). Bodies about 95% of the body limit (inflated size for gzip).
- Profiles: `*-strings`: spans with one 16 KiB attribute (body bytes dominate the charge); `*-small`: 55 000 small spans (the per-message estimate dominates). `pb` protobuf, `json` OTLP/JSON, `-gzip` compressed.
- Numbers are peaks above a post-GC baseline taken after one warm-up request, in MiB; "ext+heap / budget" is peak `external + heapUsed` over the budget. RSS on macOS is noisy (the allocator keeps freed pages); the Linux container runs are the ones to read for RSS.

Checked first (scratch script, not kept): with Node 26 every request chunk's backing store is exactly its length (3 363 chunks, 15 MiB, ratio 1.00 for 4 KiB writes; gzip output chunks share 16 KiB stores, ratio 1.01), so charging `chunk.length` is honest per chunk.

## Default budget (320 MiB, 20 MiB bodies), PostgreSQL sink, 16 clients, 10 s

`node src/ingest-memory.mjs --sink=postgres --duration=10 --concurrency=16 --budget-mib=320 --max-body-mib=20 --profiles=...` (`ingest-memory-before-pg.*`, `ingest-memory-after-pg.*`)

| profile | before: peak charged | before: arrayBuffers | before: heapUsed | before: ext+heap / budget | before: RSS | after: peak charged | after: arrayBuffers | after: heapUsed | after: ext+heap / budget | after: RSS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pb-strings | 306.5 | 471.9 | 198.5 | 2.05 | 731 | 314.8 | 354.6 | 123.9 | 1.39 | 501.1 |
| pb-strings-gzip | 304.1 | 438.4 | 125.9 | 1.76 | 811.3 | 318.6 | 420.9 | 105.7 | 1.65 | 475.1 |
| json-strings | 307.2 | 356.5 | 81.1 | 1.51 | 498.1 | 312.9 | 289.3 | 71 | 1.18 | 456.6 |
| pb-small | 319.5 | 133 | 392 | 1.52 | 526.1 | 319 | 130.4 | 397.2 | 1.58 | 533.1 |

After only, also: json-strings-gzip 1.66, pb-small-gzip 1.65.

Intermediate (join reserved, strings not yet charged), memory sink, same load: 1.30 to 1.67 (before, same sink: 1.55 to 1.75).

## Small budget (64 MiB, 16 MiB bodies), memory sink, 8 clients, 8 s

`--sink=memory --budget-mib=64 --max-body-mib=16 --concurrency=8 --duration=8` (`ingest-memory-before-memsink-64.*`, `ingest-memory-after-memsink-64.*`)

| profile | before: arrayBuffers | before: ext+heap / budget | after: arrayBuffers | after: ext+heap / budget |
| --- | --- | --- | --- | --- |
| pb-strings | 170.9 | 3.83 | 154.4 | 3.01 |
| pb-strings-gzip | 186.5 | 3.70 | 161.5 | 3.14 |
| json-strings | 154.1 | 4.30 | 141.5 | 2.33 |
| json-strings-gzip | 187.3 | 4.19 | 162.2 | 2.69 |

At a small budget the garbage of finished requests (100 to 140 MiB, waiting for V8) dominates; no accounting of requests in flight removes it. The budget is not configurable (fixed at 320 MiB), so this case is reachable only in tests.

## Container memory limit (Linux), default budget, 16 clients

The server in a container (`docker run -m <limit> --memory-swap <limit> -v <worktree>:<worktree>:ro --entrypoint node ghcr.io/nestrix-js/nestrix-server:0.9.1 --expose-gc src/ingest-memory-server.mjs`, `NESTRIX_MEM_CONFIG` with `"port":4318`), load from the host with `--external-port`. Peak RSS is absolute (idle 125 to 135 MiB).

| limit | sink | profile, duration | before | after |
| --- | --- | --- | --- | --- |
| 768 MiB | PostgreSQL (container) | pb-strings, 30 s | 482 × 200; peak RSS 558 MiB; alive | 394 × 200, 1 × 503; peak RSS 535 MiB; alive |
| 768 MiB | PostgreSQL (container) | pb-strings-gzip, 30 s | 476 × 200; peak RSS 631 MiB; alive | 477 × 200, 19 × 503; peak RSS 632 MiB; alive |
| 640 MiB | memory | pb-strings, 20 s | 16 × 200, 32 closed; peak RSS 564 MiB; alive | 120 × 200, 1 × 503; peak RSS 556 MiB; alive |
| 640 MiB | memory | pb-strings-gzip, 20 s | 53 × 200; peak RSS 602 MiB; alive | 31 × 200, 1 × 503; peak RSS 554 MiB; alive |
| 512 MiB | memory | pb-strings-gzip, 20 s | **OOM-killed** (exit 137), peak RSS 551 MiB seen | **OOM-killed** (exit 137), peak RSS 538 MiB seen |

The 32 "closed" (connection closed with no response) in one before run at 640 MiB were not explained; they did not recur.

## Reading

- Before D-116 the budget missed the join (2x the body while the chunks wait for GC) and the decoded strings (about 1x the string bytes); peak `external + heapUsed` reached 2.05x the budget.
- After, what a request in flight holds is charged (`bytes` fields are views of the body, and mapping encodes at most about 12 KiB of each); the residue is garbage of finished requests, about 1.2x to 1.7x at the default budget.
- In a Linux container the peak RSS barely moved (558/631 to 535/632 MiB): requests finish fast enough there that the budget was rarely the binding limit. Plan on idle plus 1.6x the budget (about 650 MiB); 768 MiB holds, 512 MiB does not.
- Throughput in these runs varied 2x to 6x between runs and is not a result.
