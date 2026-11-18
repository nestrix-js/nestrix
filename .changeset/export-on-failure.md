---
"@nestrix-js/nestjs": minor
---

New `export.onFailure` option (#60, D-110): a synchronous callback called once per failed export of Nestrix's own OTLP pipeline, for traces, logs and metrics, after the exporter's own retries (exactly when `getExportStatus()`'s `failures` total for that signal goes up). It receives a frozen `{ signal, reason, httpStatus, error? }` (`NestrixExportFailureEvent`, exported with `NestrixExportFailureCallback`), so an app can count failed exports in its own metrics, such as a `prom-client` counter, without polling. A callback that throws or returns a rejected promise is counted and logged once and never affects the export or the app. It is not called when the host's OpenTelemetry SDK owns the signal. A value that is not a function throws, like other invalid options.
