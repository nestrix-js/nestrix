# Exporter outage

darwin-arm64, Node v26.13.0. 600 s of load at 3000 requests/s (open rate, 64 connections) over /hello, /users/42, /spans, /spans. Queue defaults: maxQueueSize 2048, maxExportBatchSize 512. The app runs with `--expose-gc` and a forced GC precedes every heap sample (every 5 s); medians and slopes use the samples from 60 s to the end.

| config | req/s | p50 ms | p99 ms | median heap after GC MB | heap slope MB/min | median RSS MB | RSS slope MB/min | max client connections | max connections at sink | spans exported / failed / dropped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sink | 2996.7 | 3.78 | 12.93 | 23.8 | 0.03 | 220.9 | 0.14 | 1 | 1 | 4499968 / 0 / 0 |
| unreachable | 2996.6 | 3.17 | 9.12 | 26.2 | 0.01 | 206.9 | 0.67 | 2 | n/a | 0 / 37376 / 4460138 |
| blackhole | 2996.2 | 3.18 | 8.95 | 26 | 0.03 | 207.1 | 0.32 | 2 | 5 | 0 / 30720 / 4467239 |

## Allowance

`(maxQueueSize + 2 * maxExportBatchSize) * B_span + maxExportBatchSize * B_wire + 5 MB` = 8.07 MB.

- B_span = 946.2 B retained heap per queued span (re-measured in this run).
- B_wire = 610.7 B of OTLP/JSON per span (re-measured at this run's control sink).
- Client connections are counted inside the app from the `net.client.socket` diagnostics channel (created until `close`, idle keep-alive sockets included). For `unreachable` there is no server, so this is the only count; a refused attempt lives for well under a millisecond, so the sampling is exact (every socket is observed) but the maximum is of sockets alive at once, not of attempts per second.

## Verdict

### unreachable: **PASS**

1. Heap plateau: median heap-after-GC is 2.4 MB above the control's 23.8 MB; allowance 8.07 MB. pass
2. Heap trend: slope 0.01 MB/min; limit < 0.5. pass
3. RSS trend: slope 0.67 MB/min against the control's 0.14 + 1 = 1.14. pass
4. Connections: at most 2 open at once before shutdown (369 created in total; the sink saw at most n/a at once); limit 2. pass
5. p99 9.12 ms is 0.705x the control's 12.93 ms; limit 1.05. pass

### blackhole: **PASS**

1. Heap plateau: median heap-after-GC is 2.2 MB above the control's 23.8 MB; allowance 8.07 MB. pass
2. Heap trend: slope 0.03 MB/min; limit < 0.5. pass
3. RSS trend: slope 0.32 MB/min against the control's 0.14 + 1 = 1.14. pass
4. Connections: at most 2 open at once before shutdown (61 created in total; the sink saw at most 5 at once); limit 2. pass
5. p99 8.95 ms is 0.692x the control's 12.93 ms; limit 1.05. pass

## Informational: the old metric (not a criterion)

Peak RSS after 60 s minus RSS at 60 s. Allocator steps dominate it; the control has no outage and scores on it too.

| config | RSS at 60 s MB | RSS peak after MB | growth MB | last third - first third MB |
| --- | --- | --- | --- | --- |
| sink | 212 | 230.1 | 18.1 | 2.2 |
| unreachable | 202.3 | 219.4 | 17.1 | 3.5 |
| blackhole | 206.3 | 215.9 | 9.6 | 1.9 |

Notes: latency is recorded per response at 10 us resolution; with a fixed request rate it is not corrected for coordinated omission. The forced GC every 5 s is the same in every run, so it does not bias the p99 comparison.
