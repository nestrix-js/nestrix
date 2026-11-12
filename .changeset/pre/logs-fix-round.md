---
"@nestrix-js/nestjs": patch
"@nestrix-js/ui": patch
---

Logs next to the trace: the standalone server keeps identical log lines sent in the same millisecond (a retried export is still stored once) and takes its per-trace locks in lock-key order. In the embedded dashboard, trace entries made only by log lines no longer push real traces out of the store (they are capped at 10% of `store.maxTraces`), limits are enforced from the background drain instead of inside the logger call, and `ui.logs: false` stops keeping log lines.
