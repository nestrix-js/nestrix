---
"@nestrix/nestjs": minor
"@nestrix/ui": minor
---

1.0 API review (D-69). Renames and removals, before anything is published:

- `ignore.routes` is now `ignore.paths` (it matches literal request paths, not route templates).
- `methods.enabled` is gone: `methods: false` turns method spans off.
- The types `NestrixMethodOptions` and `NestrixIntegrationOptions` are now `NestrixMethodsOptions` and `NestrixIntegrationsOptions`.
- `SpanOptions` is no longer re-exported; import it from `@opentelemetry/api`.
- `logs.export` follows the metrics rule: it starts only when Nestrix owns the trace provider and trace export is on. A host-owned SDK gets no Nestrix `LoggerProvider` (one log line says so), and `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` alone no longer turns it on.
- Fixed: exported metrics carried no `service.version`.
- `user` and `authorize` accept a callback with a typed request parameter; `RedactHook` may return `void`.
- Internal to the bundled UI: `SpanRecord.service`, a required `MetaResponse.mode`, and `statistics.windowsMinutes` renamed `windowMinutesOptions`.
