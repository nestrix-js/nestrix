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
