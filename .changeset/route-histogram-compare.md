---
"@nestrix-js/nestjs": patch
"@nestrix-js/ui": patch
---

Routes view: selecting a route now shows its latency histogram (counted before sampling, with p50, p95 and p99 marked); a click on a bar opens the request list for that latency range. A new Compare tab compares the last window with the previous one, or two releases seen in the stored traces, in a sortable table that highlights regressions. New query API routes `GET api/v1/routes/histogram` and `GET api/v1/routes/compare`, and a `maxDurationMs` filter on `GET api/v1/traces`, in the embedded dashboard and the standalone server.
