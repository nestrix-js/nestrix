# Standalone server ingest memory (scratch-before-pg)

Command: `node src/ingest-memory.mjs --sink=postgres --duration=10 --concurrency=16 --budget-mib=320 --max-body-mib=20 --profiles=pb-strings,pb-strings-gzip,json-strings,pb-small --name=scratch-before-pg`

Environment: {"node":"v26.13.0","platform":"darwin-arm64","cpus":"10 logical","date":"2026-11-19T04:39:03.796Z"}. Sink: postgres. Budget 320 MiB, body limit 20 MiB, 16 connections for 10 s each, 4096-byte client writes.

Deltas are peaks over a post-GC baseline taken after one warm-up request. MiB.

| profile | wire / inflated | answers | peak charged | peak arrayBuffers | arrayBuffers at concat | peak heapUsed | peak external+heap | peak RSS | external+heap / budget |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pb-strings | 19 / 19 | 200: 305 | 306.5 | 471.9 | 471.9 | 198.5 | 655.8 | 731 | 2.05 |
| pb-strings-gzip | 10.3 / 19 | 200: 304 | 304.1 | 438.4 | 438.4 | 125.9 | 563.9 | 811.3 | 1.76 |
| json-strings | 19 / 19 | 200: 128 | 307.2 | 356.5 | 356.5 | 81.1 | 484.5 | 498.1 | 1.51 |
| pb-small | 6.9 / 6.9 | 200: 58, 503: 2 | 319.5 | 133 | 133 | 392 | 485.5 | 526.1 | 1.52 |
