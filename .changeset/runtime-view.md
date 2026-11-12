---
"@nestrix-js/nestjs": patch
"@nestrix-js/ui": patch
---

Dashboard: a Runtime view for the embedded dashboard. While the dashboard is on, a small in-process sampler (every 10 s, unref'd, stopped at shutdown, nothing per request, no MeterProvider needed) keeps 60 minutes of event loop delay (p50, p99, max), heap, RSS, external memory, CPU user and system percent and active handles, served by `GET api/v1/runtime`. The UI shows current-value tiles and four charts. `meta.runtime.available` is false in the standalone server, which hides the tab.
