# Throughput and latency

darwin-arm64, Node v26.13.0, 2 fresh-process run(s) per configuration, 5 s per route after 2 s warmup, 64 connections (closed loop). Values are medians across runs. Load generator, app and sink are separate processes on one machine. Delta is throughput against the uninstrumented run of the same route.

| config | route | p50 ms | p99 ms | req/s | vs baseline | CPU % of one core | RSS MB | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| headless | GET /hello | 2.185 | 4.335 | 28006 |  | 103.3 | 276.7 | 0 |
| headless | GET /users/:id | 2.28 | 4.54 | 26897 |  | 103 | 228.2 | 0 |
| headless | GET /spans (3 manual spans) | 2.42 | 4.8 | 25300 |  | 104.3 | 273.2 | 0 |
| dashboard | GET /hello | 2.605 | 3.74 | 23794 |  | 108.5 | 325.6 | 0 |
| dashboard | GET /users/:id | 2.71 | 3.83 | 22948 |  | 107.2 | 289 | 0 |
| dashboard | GET /spans (3 manual spans) | 3.075 | 4.64 | 19952 |  | 110 | 340.9 | 0 |

Startup (spawn to first 200 on /hello, median): headless 280.7 ms, dashboard 286.2 ms.
