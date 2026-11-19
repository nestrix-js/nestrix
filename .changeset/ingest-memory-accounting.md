---
"@nestrix-js/nestjs": patch
---

Standalone server: the ingest memory budget now also charges the joined copy of a body that arrived in several chunks, and the strings a body decodes into, so peak memory stays closer to the budget under bursts of large exports. A join that cannot be allocated answers 503 instead of escaping as an uncaught exception.
