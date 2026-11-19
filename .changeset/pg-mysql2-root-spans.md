---
"@nestrix-js/nestjs": minor
---

`pg` and `mysql2`: a query that runs outside any trace no longer gets a span (D-115), as `ioredis` commands already did (D-60). Start-up migrations, a scheduler's or workflow engine's poll and other queries with no active span used to become one-span root traces that crowded the trace list (one app stored 838 traces in its first minute, 6 of them requests). Queries inside a request, job or traced method are unchanged, and the `pg.pool.connect` span and pool metrics are unchanged. New option: `integrations.pg` takes `{ rootSpans?: boolean, poolWaitThresholdMillis? }` and `integrations.mysql2` takes `true` or `{ rootSpans?: boolean }`; a non-boolean `rootSpans` throws at `forRoot()`.

**Upgrade:** to keep the old behaviour, set `integrations: { pg: { rootSpans: true } }` (and `mysql2: { rootSpans: true }` if you use `mysql2`).
