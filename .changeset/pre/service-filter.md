---
"@nestrix-js/nestjs": minor
"@nestrix-js/ui": minor
---

Query API: the lists and statistics accept an optional `service` parameter (traces, errors, routes, classes, map), and `meta` reports `mode` (`embedded` here) for the standalone server's multi-service API. The embedded dashboard serves one application, so a `service` other than its own name answers empty results.
