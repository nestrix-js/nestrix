# Startup time

darwin-arm64, Node v26.13.0. Time from spawn to the first 200 on `GET /hello`, 15 fresh processes per configuration (interleaved, after one discarded warm-up round). "Added" is the median minus the uninstrumented median. The exporting configurations point at a local sink and do not wait for it; export is asynchronous.

| config | median ms | min ms | max ms | added vs baseline ms |
| --- | --- | --- | --- | --- |
| baseline | 281.7 | 253.8 | 310.6 |  |
| noexport | 338.6 | 298.1 | 493.6 | 56.9 |
| sink | 344.2 | 304.4 | 431.5 | 62.5 |
