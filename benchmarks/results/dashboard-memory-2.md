# Dashboard memory

darwin-arm64, Node v26.13.0. One fresh process per configuration (`--expose-gc`); 3 s of load on GET /users/42 at 64 connections, then a forced GC. The store is at its default limits.

| config | idle RSS MB | idle heap MB | RSS after load MB | RSS after load + GC MB | heap after load + GC MB | heap total MB | external MB | store traces | store estimate MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| headless | 119.6 | 21.3 | 277.4 | 277.4 | 23.5 | 88.3 | 4.7 |  |  |
| headless-eager | 127 | 22.4 | 261.9 | 261.7 | 24.6 | 113.8 | 5.1 |  |  |
| dashboard | 125.4 | 21.5 | 296.6 | 295.3 | 31.5 | 146.2 | 5.9 | 5000 | 6.5 |
