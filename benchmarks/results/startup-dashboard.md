# Startup time

darwin-arm64, Node v26.13.0. Time from spawn to the first 200 on `GET /hello`, 20 fresh processes per configuration (interleaved, after one discarded warm-up round). "Added" is the median minus the uninstrumented median. The exporting configurations point at a local sink and do not wait for it; export is asynchronous.

| config | median ms | min ms | max ms | added vs baseline ms |
| --- | --- | --- | --- | --- |
| baseline | 246.1 | 238.9 | 248.9 |  |
| headless | 278.8 | 271.1 | 305.3 | 32.7 |
| headless-eager | 295.2 | 288.6 | 300.8 | 49.1 |
| dashboard | 282.9 | 272 | 288.8 | 36.8 |
