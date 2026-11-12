---
"@nestrix-js/nestjs": patch
"@nestrix-js/ui": patch
---

Dependencies page and request timeline. `GET api/v1/dependencies` lists each outbound target (database, cache, HTTP host, queue) with calls, errors, p50 and p95 and a per-bucket calls and p95 series; the new Dependencies view shows them by total time with sparklines and opens the slowest call's trace. `GET api/v1/traces/timeline` counts sampled requests per bucket as ok, 4xx and 5xx or error; a stacked chart above the request list sets a time range on the list by dragging or clicking a bar, through the new `fromUnixMs` and `toUnixMs` parameters of `GET api/v1/traces`. Both are built from the stored, sampled traces.
