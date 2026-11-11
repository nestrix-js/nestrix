# Dashboard memory

darwin-arm64, Node v26.13.0. One fresh process per configuration (`--expose-gc`); 5 s of load on GET /users/42 at 64 connections, then a forced GC. The store is at its default limits.

| config | idle RSS MB | idle heap MB | RSS after load MB | RSS after load + GC MB | heap after load + GC MB | heap total MB | external MB | store traces | store estimate MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| headless | 125.3 | 21.3 | 252.6 | 252.7 | 21.5 | 89.8 | 4.7 |  |  |
| dashboard | 125.6 | 21.5 | 323.6 | 322.3 | 32 | 152.5 | 6.1 | 5000 | 6.5 |
