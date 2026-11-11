# Throughput and latency

darwin-arm64, Node v26.13.0, 2 fresh-process run(s) per configuration, 5 s per route after 2 s warmup, 64 connections (closed loop). Values are medians across runs. Load generator, app and sink are separate processes on one machine. Delta is throughput against the uninstrumented run of the same route.

| config | route | p50 ms | p99 ms | req/s | vs baseline | CPU % of one core | RSS MB | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dashboard | GET /hello | 2.61 | 3.72 | 23831 |  | 108.1 | 324.3 | 0 |
| dashboard | GET /users/:id | 2.715 | 3.9 | 22855 |  | 107.8 | 300.9 | 0 |
| dashboard | GET /spans (3 manual spans) | 3.08 | 4.46 | 19978 |  | 110.1 | 342.2 | 0 |
| headless | GET /hello | 2.19 | 4.345 | 27925 |  | 103.3 | 277.4 | 0 |
| headless | GET /users/:id | 2.28 | 4.51 | 26960 |  | 103.1 | 252 | 0 |
| headless | GET /spans (3 manual spans) | 2.425 | 4.82 | 25219 |  | 104.6 | 273.6 | 0 |

Startup (spawn to first 200 on /hello, median): dashboard 283 ms, headless 278.6 ms.
