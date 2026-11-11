# Dashboard micro-costs

darwin-arm64, Node v26.13.0. One process, no HTTP; median of 3 timed loops.

| what | ns per call |
| --- | --- |
| RouteStatistics.record() (3 keys) | 70 |
| SDK span: start, 6 attributes, end, no processor | 1560 |
| same, with the store processor (enqueue + drain, default limits) | 3497 |
| store processor, per span (difference) | 1937 |
