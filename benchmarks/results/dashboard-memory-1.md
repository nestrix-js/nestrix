# Dashboard memory

darwin-arm64, Node v26.13.0. One fresh process per configuration (`--expose-gc`); 3 s of load on GET /users/42 at 64 connections, then a forced GC. The store is at its default limits.

| config | idle RSS MB | idle heap MB | RSS after load MB | RSS after load + GC MB | heap after load + GC MB | heap total MB | external MB | store traces | store estimate MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| headless | 125.4 | 21.3 | 245.9 | 245.9 | 23.5 | 98.5 | 4.8 |  |  |
| headless-eager | 126 | 22.4 | 274.9 | 274.8 | 24.6 | 89.5 | 4.7 |  |  |
| dashboard | 121.2 | 21.5 | 317.5 | 317.6 | 31.5 | 101.5 | 5.5 | 5000 | 6.5 |
