---
"@nestrix-js/nestjs": minor
---

Add `bullmqTelemetry()`, BullMQ's `telemetry` implemented on Nestrix's own OpenTelemetry API with no dependency on `bullmq` or `bullmq-otel` (issue #20). Pass `telemetry: bullmqTelemetry({ tracerName })` to `BullModule.forRoot()`. It looks its tracer up on first use, so BullMQ's producer, consumer and complete/fail spans are recorded in ESM apps, where a `new BullMQOtel()` created in `BullModule.forRoot()` loads the CommonJS copy of `@opentelemetry/api` before Nestrix registers its provider and silently records nothing. A failed job's `process` span now carries the exception and error status, the job's return value is never recorded, BullMQ's parentless housekeeping spans are dropped unless `rootSpans: true`, and `enableMetrics: true` adds BullMQ's job metrics. The README's BullMQ section now uses the helper and shows how to keep `bullmq-otel` by building it on first use.
