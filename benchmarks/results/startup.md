# Startup time

darwin-arm64, Node v26.13.0. Time from spawn to the first 200 on `GET /hello`, 15 fresh processes per configuration (interleaved, after one discarded warm-up round). "Added" is the median minus the uninstrumented median. The exporting configurations point at a local sink and do not wait for it; export is asynchronous.

| config | median ms | min ms | max ms | added vs baseline ms |
| --- | --- | --- | --- | --- |
| baseline | 268.8 | 261.2 | 291.4 |  |
| noexport | 320.3 | 309.7 | 383.1 | 51.5 |
| sink | 318.8 | 310 | 371.9 | 50 |
