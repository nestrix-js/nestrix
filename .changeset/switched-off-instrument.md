---
"@nestrix-js/nestjs": patch
---

A switched-off Nestrix no longer touches your classes or loads the OpenTelemetry SDK (#41). With `NESTRIX_ENABLED=false`, or `forRoot({ enabled: false })`, `NestrixInstrument` leaves every controller and service instance exactly as Nest created it. The SDK, the exporters and the dashboard code are now loaded with `import()` only when Nestrix is on, so importing the package in a disabled app costs a few milliseconds instead of tens. New `nestrixInstrumentIf(enabled)` returns `NestrixInstrument` or `undefined`, for switching method spans from configuration (for example together with `forRootAsync`).
