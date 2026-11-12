---
"@nestrix-js/nestjs": minor
"@nestrix-js/ui": minor
---

New **route detail** page (`/route?method=&route=`) that explains why a route changed, window against window or release against release: a "What changed" summary with ranked findings (a new statement, an N+1 pattern, a slower statement, dependency or method, new or more errors, and what got faster), time per request by span kind for each side, statements, methods, dependencies, errors and the slowest traces. Served by the new `GET api/v1/routes/explain` on both the embedded dashboard and the standalone server. Reached from the Overview, the Routes page and the trace view. The Queries, Dependencies, Classes and Errors pages accept filters (`q`, `name`, `class`, `type`) so each finding links straight to its rows.
