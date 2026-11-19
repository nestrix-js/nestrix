# Standalone server ingest memory (ingest-memory-after-memsink-64)

Command: `node src/ingest-memory.mjs --sink=memory --duration=8 --concurrency=8 --profiles=pb-strings,pb-strings-gzip,json-strings,json-strings-gzip --name=ingest-memory-after-memsink-64`

Environment: {"node":"v26.13.0","platform":"darwin-arm64","cpus":"10 logical","date":"2026-11-19T04:56:25.455Z"}. Sink: memory. Budget 64 MiB, body limit 16 MiB, 8 connections for 8 s each, 4096-byte client writes.

Deltas are peaks over a post-GC baseline taken after one warm-up request. MiB.

| profile | wire / inflated | answers | peak charged | peak arrayBuffers | arrayBuffers at concat | peak heapUsed | peak external+heap | peak RSS | external+heap / budget |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pb-strings | 15.2 / 15.2 | 200: 27, 503: 319 | 64 | 154.4 | 154.4 | 37.9 | 192.3 | 862.8 | 3.01 |
| pb-strings-gzip | 8.3 / 15.2 | 200: 57, 503: 310 | 64 | 161.5 | 155.4 | 39.7 | 201.1 | 197 | 3.14 |
| json-strings | 15.2 / 15.2 | 200: 1, 503: 284 | 64 | 141.5 | 141.5 | 18.4 | 149.1 | 134.4 | 2.33 |
| json-strings-gzip | 8.1 / 15.2 | 200: 5, 503: 286 | 64 | 162.2 | 162.2 | 20.2 | 172 | 191.1 | 2.69 |
