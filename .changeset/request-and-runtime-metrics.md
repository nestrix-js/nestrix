---
"@nestrix/nestjs": minor
"@nestrix/ui": minor
---

Metrics: `http.server.request.duration` for every request (sampled or not) and runtime metrics (event-loop delay, V8 heap, RSS, CPU time), recorded through `@opentelemetry/api` so a host `MeterProvider` receives them. When Nestrix owns the tracer provider and exports traces, it also exports metrics over OTLP/HTTP to `/v1/metrics`, given the optional peers `@opentelemetry/sdk-metrics` and `@opentelemetry/exporter-metrics-otlp-http`. New option `metrics?: false | { runtime?: boolean }`.
