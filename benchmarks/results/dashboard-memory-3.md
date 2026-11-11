# Dashboard memory

darwin-arm64, Node v26.13.0. One fresh process per configuration (`--expose-gc`); 3 s of load on GET /users/42 at 64 connections, then a forced GC. The store is at its default limits.

| config | idle RSS MB | idle heap MB | RSS after load MB | RSS after load + GC MB | heap after load + GC MB | heap total MB | external MB | store traces | store estimate MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| headless | 120.3 | 21.3 | 243.5 | 243.6 | 23.5 | 105 | 4.9 |  |  |
| headless-eager | 126.2 | 22.4 | 251.5 | 251.3 | 24.6 | 112.3 | 5.3 |  |  |
| dashboard | 121 | 21.5 | 302 | 300.5 | 31.3 | 146.2 | 6.1 | 5000 | 6.5 |
