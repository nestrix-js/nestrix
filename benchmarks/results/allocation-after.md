# Allocation per request (allocation-after)

darwin-arm64, Node v26.13.0. 3 fresh-process runs per config, 8 s after a 2 s warmup, 64 connections, /hello and /users/42 alternating. Medians. Bytes are V8 `total_allocated_bytes` deltas in the app process per completed request (includes Node http and Nest); scavenges are gc PerformanceObserver minor entries.

| config | B/request | Nestrix share B/request | scavenges / 10k req | req/s |
| --- | --- | --- | --- | --- |
| baseline | 14584 |  | 9.89 | 42582 |
| interceptor | 31208 | 16624 | 19.83 | 35724 |
| headless | 42057 | 27473 | 13.92 | 27857 |
| dashboard | 45815 | 31231 | 14.71 | 24935 |
