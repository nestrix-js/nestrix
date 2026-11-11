# Allocation per request (allocation-before)

darwin-arm64, Node v26.13.0. 3 fresh-process runs per config, 8 s after a 2 s warmup, 64 connections, /hello and /users/42 alternating. Medians. Bytes are V8 `total_allocated_bytes` deltas in the app process per completed request (includes Node http and Nest); scavenges are gc PerformanceObserver minor entries.

| config | B/request | Nestrix share B/request | scavenges / 10k req | req/s |
| --- | --- | --- | --- | --- |
| baseline | 14442 |  | 9.84 | 43177 |
| headless | 44191 | 29749 | 14.3 | 27455 |
| dashboard | 48367 | 33925 | 15.54 | 23009 |
