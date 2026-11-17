# Logs and metrics

## Logs

Nestrix patches nothing in Nest's logger. To put the trace and span id on your log lines, pass `NestrixLogger` (a `ConsoleLogger`) as the application logger:

```ts
const app = await NestFactory.create(AppModule, {
  logger: new NestrixLogger(),
});
```

While a span is active, text lines end with ` trace_id=… span_id=…`. In JSON mode (`new NestrixLogger({ json: true })`) each line gets `trace_id` and `span_id` fields. Outside a span the output is `ConsoleLogger`'s. For pino, winston or `nestjs-pino`, `getTraceIds()` returns `{ traceId, spanId }` of the active span, or `undefined`; use it in a `mixin` or format function.

A failure in correlation or export never changes what the log call prints or throws.

### Logs next to the trace

With the dashboard on, `NestrixLogger` lines written under a recording span are also kept with their trace and shown beside the waterfall; the standalone server does the same for records sent to its `/v1/logs`. This is context for a trace, not log storage or search. See [Dashboard](/guide/dashboard#logs-next-to-the-trace) for the limits and `ui.logs` to switch it off.

### Exporting logs

Set `logs: { export: true }` to also send every `NestrixLogger` record over OTLP/HTTP to `/v1/logs` of the configured endpoint (`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is used as given once trace export is on; it does not turn export on by itself). Like metrics, this runs only when Nestrix owns the tracer provider: with a host-owned SDK Nestrix registers no `LoggerProvider` and logs one line saying so. Records carry Nest's level as OpenTelemetry severity, the logger context as `nestrix.log.context`, and the active span's context.

This needs two optional packages. Without them Nestrix logs one line with the command and carries on:

```bash
npm install @opentelemetry/sdk-logs @opentelemetry/exporter-logs-otlp-http
```

If your app already registered a `LoggerProvider`, the records go to it and Nestrix registers nothing. Records logged before the packages finish loading at startup are printed but not exported.

## Metrics

Nestrix records metrics through `@opentelemetry/api`'s metrics API. If your app registers a `MeterProvider` (the OpenTelemetry Node SDK does), it receives them as they are.

- **`http.server.request.duration`**, a histogram in seconds with the bucket boundaries the HTTP semantic conventions advise, for every request, sampled or not. Attributes: `http.request.method`, `url.scheme`, `http.route` (when a handler matched), `http.response.status_code` and `error.type` (on the same rule as the span's error status). Requests under `ignore.paths` and the dashboard path are not counted.
- **Runtime metrics**, read only when a reader collects: `nodejs.eventloop.delay.p50`, `.p99` and `.max`, `v8js.memory.heap.used` and `v8js.memory.heap.space.size` (per `v8js.heap.space.name`), `process.memory.usage` (RSS) and `process.cpu.time` (per `cpu.mode`). Names follow `@opentelemetry/semantic-conventions` 1.45.0, where they are still experimental and may be renamed.

With no `MeterProvider` registered and no export, nothing is recorded and the event-loop monitor does not run.

### Exporting metrics

When Nestrix owns the tracer provider and exports traces, it also exports metrics over OTLP/HTTP to `/v1/metrics` of the same endpoint (or `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`), every 60 seconds (`OTEL_METRIC_EXPORT_INTERVAL`), with the same headers and timeout. This needs two optional packages:

```bash
pnpm add @opentelemetry/sdk-metrics@^3.1.1 @opentelemetry/exporter-metrics-otlp-http@^0.301.1
```

Without them Nestrix logs one line with that command and metrics stay API-only. Nestrix registers its own `MeterProvider` only when none is registered, never replaces yours, and flushes it on `app.close()` within the same 5-second bound as spans.

```ts
NestrixModule.forRoot({
  export: { otlp: { endpoint: "http://otel-collector:4318" } },
  metrics: { runtime: true }, // the default; `false` records no metrics at all
});
```

Options: `metrics: false`, `metrics.runtime` and `metrics.export`; see the [reference](/reference/configuration#metrics).

An endpoint that answers 404, 405 or 501 on its metrics URL does not accept metrics (the [standalone server](/guide/standalone-server) ingests traces and logs only, and so does Jaeger). Nestrix then logs one line and stops exporting metrics until the app restarts; traces and logs carry on.

## Export health

When Nestrix owns the pipeline, it tells you when telemetry is not getting through. Requests are never slowed or failed by it.

- **Log lines**, through Nest's `Logger` (context `Nestrix`): one warning when exports of a signal start failing, with the reason (`unreachable`, `unauthorized` for 401/403, `rate_limited` for 429, `server_error` for 5xx, `timeout`, `not_supported` for 404/405/501, `other`), one more if the reason changes during the same outage, and one line when exports work again. Never one per batch. The warning comes when the first export after the outage gives up on its retries: for spans within `export.queue.scheduledDelayMillis` plus `export.otlp.timeoutMillis` (5 s + 10 s by default).
- **`getExportStatus()`**, exported from `@nestrix-js/nestjs`: a frozen snapshot per signal (`traces`, `logs`, `metrics`) with `state` (`inactive`, `pending`, `ok`, `failing`, `stopped`), `lastSuccessAt`, `lastFailureAt`, `lastFailure` (`{ reason, httpStatus }`), `consecutiveFailures`, `failures` by reason and `dropped` (spans or log records dropped from the full queue), and `degraded`. No I/O; never throws.
- **Two observable counters** on the registered `MeterProvider` (Nestrix's or yours): `nestrix.export.failures` (`signal`, `reason`) and `nestrix.export.dropped` (`signal`). A failing metric export reports its own failures in the next export that succeeds, and causes no extra export.

With Nestrix disabled, export off, or your own OpenTelemetry SDK owning the signal, every signal is `inactive`, no counter is added and nothing is logged: Nestrix does not read a host's exporters (D-69).

### In a readiness check: degraded, not down

Report telemetry as a detail of your health endpoint. Do not fail readiness or liveness on it: an observability outage must not make Kubernetes restart your pods or take them out of the load balancer.

```ts
import { Controller, Get } from "@nestjs/common";
import { getExportStatus } from "@nestrix-js/nestjs";

@Controller("health")
export class HealthController {
  @Get("ready")
  ready() {
    const telemetry = getExportStatus();
    return {
      status: "ok", // decided by your own checks (database, queues)
      telemetry: telemetry.degraded ? "degraded" : "ok",
      traces: telemetry.traces.state,
      lastTraceFailure: telemetry.traces.lastFailure,
    };
  }
}
```

With `@nestjs/terminus`, return the same as the details of an indicator that is always `up`. To alert, use the counters, for example `increase(nestrix_export_failures_total[10m]) > 0` with a Prometheus bridge.
