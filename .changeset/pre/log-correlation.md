---
"@nestrix-js/nestjs": minor
"@nestrix-js/ui": minor
---

Log correlation. `NestrixLogger` (a Nest `ConsoleLogger`) adds `trace_id` and `span_id` of the active span to text and JSON log lines, and `getTraceIds()` returns them for pino, winston and `nestjs-pino`. With `logs: { export: true }` and the optional packages `@opentelemetry/sdk-logs` and `@opentelemetry/exporter-logs-otlp-http` installed, every record is also sent over OTLP/HTTP to `/v1/logs`.
