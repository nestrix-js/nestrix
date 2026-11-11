# Outage diagnosis

600 s at 3000 requests/s. Heap and external memory are read after a forced GC at every sample; trends are least-squares MB per minute after 60 s.

| config | RSS MB/min | heap after GC MB/min | external MB/min | RSS last third - first third MB |
| --- | --- | --- | --- | --- |
| sink | -0.55 | 0 | 0 | -2.7 |
| unreachable | 0.83 | 0.17 | 0.03 | 4.5 |
