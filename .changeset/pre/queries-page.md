---
"@nestrix-js/nestjs": patch
"@nestrix-js/ui": patch
---

New Queries page and `GET api/v1/queries`: database and cache statements (`db.query.text`) aggregated across the stored, sampled traces of a 15 or 60 minute window, with count, total, average, p95, max, errors, traces, the number of traces where a statement ran 3 or more times (N+1 candidates) and up to 3 example traces. Sortable, with an N+1 filter. The numbers come from sampled traces, not from every query.
