# Throughput and latency

darwin-arm64, Node v26.13.0, 2 fresh-process run(s) per configuration, 5 s per route after 2 s warmup, 64 connections (closed loop). Values are medians across runs. Load generator, app and sink are separate processes on one machine. Delta is throughput against the uninstrumented run of the same route.

| config | route | p50 ms | p99 ms | req/s | vs baseline | CPU % of one core | RSS MB | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| headless | GET /hello | 2.16 | 4.325 | 28166 |  | 103.5 | 277.3 | 0 |
| headless | GET /users/:id | 2.255 | 4.51 | 27170 |  | 103.5 | 230.5 | 0 |
| headless | GET /spans (3 manual spans) | 2.405 | 4.84 | 25406 |  | 105.2 | 272.4 | 0 |
| dashboard | GET /hello | 2.385 | 3.56 | 25721 |  | 107.1 | 325.7 | 0 |
| dashboard | GET /users/:id | 2.485 | 3.53 | 24875 |  | 105.9 | 288 | 0 |
| dashboard | GET /spans (3 manual spans) | 2.71 | 4.23 | 22550 |  | 109.6 | 337.8 | 0 |

Startup (spawn to first 200 on /hello, median): headless 292.2 ms, dashboard 290.1 ms.
