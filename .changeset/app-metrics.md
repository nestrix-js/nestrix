---
"@nestrix-js/ui": minor
---

Application metrics in the standalone server ([#87](https://github.com/nestrix-js/nestrix/issues/87), D-118). With the new opt-in `NESTRIX_METRICS=all`, `POST /v1/metrics` also stores an application's own OpenTelemetry metrics of any name (Gauge, Sum and explicit-bucket Histogram, with their unit and up to 16 attributes per point), bounded by the existing series caps and a new `NESTRIX_METRICS_MAX_NAMES_PER_SERVICE` (200). The Metrics page lists them after the runtime charts, with a search when there are many: a counter as a rate, a gauge as its level, a histogram as p50/p95/p99, each optionally split by one of its attributes. `NESTRIX_METRICS=on` and `off` behave as before.
