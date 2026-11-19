# Standalone server ingest memory (ingest-memory-before-memsink)

Command: `node src/ingest-memory.mjs --sink=memory --duration=8 --concurrency=8 --name=ingest-memory-before-memsink`

Environment: {"node":"v26.13.0","platform":"darwin-arm64","cpus":"10 logical","date":"2026-11-19T04:26:16.401Z"}. Sink: memory. Budget 64 MiB, body limit 16 MiB, 8 connections for 8 s each, 4096-byte client writes.

Deltas are peaks over a post-GC baseline taken after one warm-up request. MiB.

| profile | wire / inflated | answers | peak charged | peak arrayBuffers | arrayBuffers at concat | peak heapUsed | peak external+heap | peak RSS | external+heap / budget |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pb-strings | 15.2 / 15.2 | 200: 158, 503: 160 | 64 | 170.9 | 170.2 | 74.4 | 245.2 | 505.3 | 3.83 |
| pb-strings-gzip | 8.3 / 15.2 | 200: 206, 503: 208 | 64 | 186.5 | 183.8 | 60.3 | 237 | 254.1 | 3.7 |
| json-strings | 15.2 / 15.2 | 200: 104, 503: 119 | 64 | 154.1 | 154.1 | 79 | 274.9 | 229.9 | 4.3 |
| json-strings-gzip | 8.1 / 15.2 | 200: 117, 503: 124, reset: 2 | 64 | 187.3 | 167 | 58 | 268.4 | 336.2 | 4.19 |
| pb-small | 6.9 / 6.9 | 413: 223 | 53.9 | 115.2 | 115.2 | 58.8 | 160.4 | 152 | 2.51 |
| pb-small-gzip | 2.2 / 6.9 | 413: 55 | 53.6 | 123.8 | 106.5 | 30.4 | 134.6 | 113.3 | 2.1 |
