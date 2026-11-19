---
"@nestrix-js/nestjs": minor
---

Standalone server: `NESTRIX_INGEST_MEMORY_BUDGET_MB` (32 to 1024, default 320) sets the memory budget for ingest requests in flight, so the container can run in less memory (at least 200 MiB + 1.6 x the budget). Below the default, the per-request limits (body size, spans, messages, JSON values) shrink in proportion so a request at every limit still fits; unset, nothing changes.
