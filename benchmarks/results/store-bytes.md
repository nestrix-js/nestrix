# Store bytes per trace

darwin-arm64, Node v26.13.0. Heap growth after a forced GC (twice) per stored trace, with limits set so nothing is evicted; median of 3 fresh-process runs. The estimate is the store's own `stats().bytes` (the figure `maxBytes` is compared against).

| shape | spans/trace | heap B/trace | estimate B/trace | estimate / heap |
| --- | --- | --- | --- | --- |
| 1: server span only | 1 | 1358 | 1523 | 1.12 |
| 2: server + 5 client spans | 6 | 3972 | 4852 | 1.22 |
| 3: server + 50 spans, attributes, exception event | 51 | 27798 | 31846 | 1.15 |

## At the default limits

Each shape fed through a store with the default limits until it evicts. Heap growth is after a forced GC, measured from before any trace (warm-up included).

| shape | traces fed | stored | evicted | estimate MiB | heap growth MiB |
| --- | --- | --- | --- | --- | --- |
| 1: server span only | 20200 | 5000 | 15200 | 7.3 | 7 |
| 2: server + 5 client spans | 20200 | 5000 | 15200 | 23.2 | 19.5 |
| 3: server + 50 spans, attributes, exception event | 3200 | 1052 | 2148 | 32 | 28.1 |
