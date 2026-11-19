# Standalone server ingest memory (ingest-memory-after-pg)

Command: `node src/ingest-memory.mjs --sink=postgres --duration=10 --concurrency=16 --budget-mib=320 --max-body-mib=20 --profiles=pb-strings,pb-strings-gzip,json-strings,json-strings-gzip,pb-small,pb-small-gzip --name=ingest-memory-after-pg`

Environment: {"node":"v26.13.0","platform":"darwin-arm64","cpus":"10 logical","date":"2026-11-19T04:41:54.280Z"}. Sink: postgres. Budget 320 MiB, body limit 20 MiB, 16 connections for 10 s each, 4096-byte client writes.

Deltas are peaks over a post-GC baseline taken after one warm-up request. MiB.

| profile | wire / inflated | answers | peak charged | peak arrayBuffers | arrayBuffers at concat | peak heapUsed | peak external+heap | peak RSS | external+heap / budget |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pb-strings | 19 / 19 | 200: 52, 503: 2 | 314.8 | 354.6 | 354.6 | 123.9 | 444 | 501.1 | 1.39 |
| pb-strings-gzip | 10.3 / 19 | 200: 28, 503: 4 | 318.6 | 420.9 | 420.9 | 105.7 | 526.6 | 475.1 | 1.65 |
| json-strings | 19 / 19 | 200: 40 | 312.9 | 289.3 | 289.3 | 71 | 378.8 | 456.6 | 1.18 |
| json-strings-gzip | 10.2 / 19 | 200: 96, 503: 21 | 320 | 405 | 405 | 73.9 | 529.9 | 669.7 | 1.66 |
| pb-small | 6.9 / 6.9 | 200: 80, 503: 10 | 319 | 130.4 | 130.4 | 397.2 | 506.4 | 533.1 | 1.58 |
| pb-small-gzip | 2.2 / 6.9 | 200: 31, 503: 4 | 318 | 151.8 | 151.8 | 389.7 | 529.3 | 378.9 | 1.65 |
