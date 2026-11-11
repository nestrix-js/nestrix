# Exporter outage

darwin-arm64, Node v26.13.0. 600 s of load at 3000 requests/s (open rate, 64 connections) over /hello, /users/42, /spans, /spans; RSS sampled every 5 s; growth is measured from the first sample at or after 60 s to the peak after it. Queue defaults: maxQueueSize 2048, maxExportBatchSize 512.

| config | req/s | p50 ms | p99 ms | RSS at 60 s MB | RSS peak after MB | growth MB | spans exported / failed / dropped |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sink | 2997.2 | 1.92 | 6.04 | 193.8 | 214.5 | 20.7 | 2699776 / 0 / 0 |
| unreachable | 2996.9 | 1.83 | 5.75 | 233.8 | 299.8 | 66 | 0 / 1422336 / 1262816 |
| blackhole | 2996.9 | 1.84 | 5.19 | 194.5 | 221 | 26.5 | 0 / 224768 / 2471136 |

## RSS bound

`(maxQueueSize + maxExportBatchSize) * heapBytesPerSpan + maxExportBatchSize * wireBytesPerSpan + rssNoiseMb`

- heapBytesPerSpan = 865.3 B, the marginal retained heap per queued span (heap after GC with a blackholed queue of 2048 against 20480 spans, median of 3 runs each; both queues overflowed: dropped {"2048":169349,"20480":566303}).
- wireBytesPerSpan = 354.9 B, from the control run's sink (OTLP/JSON bytes received per span).
- rssNoiseMb = 20.7 MB, the control run's own RSS growth after 60 s, with no outage.
- bound = 23 MB.

## Verdict

- unreachable: RSS growth 66 MB against a bound of 23 MB (EXCEEDED); p99 5.75 ms is 0.952x the control's 6.04 ms (within 5%). **FAIL**
- blackhole: RSS growth 26.5 MB against a bound of 23 MB (EXCEEDED); p99 5.19 ms is 0.859x the control's 6.04 ms (within 5%). **FAIL**

Notes: latency is recorded per response at 10 us resolution; with a fixed request rate it is not corrected for coordinated omission. Until HTTP server spans exist (P1-06) the only spans are the three `withSpan` spans of `/spans`.

## Diagnostics computed afterwards (not part of the pass criteria)

Added after the verdict above was produced, from the saved RSS samples in `outage.json` (least-squares slope of RSS over the samples at or after 60 s, and the mean of the last third of those samples minus the mean of the first third):

| config | RSS trend MB/min | last third - first third MB | mean RSS after 60 s MB |
| --- | --- | --- | --- |
| sink (control) | 0.68 | 5.7 | 193.0 |
| unreachable | 3.96 | 24.2 | 248.1 |
| blackhole | 0.92 | 6.6 | 196.8 |

The verdicts above stand as produced. Two things the numbers say about them. The growth metric (peak sample minus one sample) is itself noisy: the healthy control scores 20.7 MB on it, and the bound is mostly that noise term (the queue term is 2.2 MB). And the `unreachable` run sits on a higher RSS plateau than the control, with a visible upward drift in RSS over the run. `outage-diagnose.md` is a second 600 s run of `sink` and `unreachable` with a forced GC at every sample: for `unreachable` the heap after GC settles at about 44 MB against about 23 MB for the healthy sink, flat from 80 s on (trend 0.17 MB/min). So the drift in RSS is allocator and GC slack on top of a retained heap that is bounded but larger than the queue-derived prediction, not growth in retained heap.
