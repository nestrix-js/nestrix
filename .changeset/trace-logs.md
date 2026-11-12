---
"@nestrix-js/nestjs": patch
"@nestrix-js/ui": patch
---

Logs next to the trace. With the dashboard on, `NestrixLogger` lines written under a recording span are kept with their trace (after the logger's `redact`, cut to 8 KiB, at most 200 per trace, counted in the store's byte budget and evicted with the trace) and served by `GET api/v1/trace/logs?id=`. The trace view lists them in a Logs panel with level colouring, marks the waterfall rows of the spans that logged, and selects a line's span on click. The standalone server accepts OTLP logs on `/v1/logs` with the same protections as `/v1/traces` and keeps records that carry a trace id. Not a log backend: there is no search across lines.
