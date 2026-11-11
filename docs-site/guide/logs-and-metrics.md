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

### Exporting logs

Set `logs: { export: true }` to also send every `NestrixLogger` record over OTLP/HTTP to `/v1/logs` of the configured endpoint (`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is used as given). Records carry Nest's level as OpenTelemetry severity, the logger context as `nestrix.log.context`, and the active span's context.

This needs two optional packages. Without them Nestrix logs one line with the command and carries on:

```bash
npm install @opentelemetry/sdk-logs @opentelemetry/exporter-logs-otlp-http
```

If your app already registered a `LoggerProvider`, the records go to it and Nestrix registers nothing. Records logged before the packages finish loading at startup are printed but not exported.

## Metrics

Nestrix records metrics through `@opentelemetry/api`'s metrics API. If your app registers a `MeterProvider` (the OpenTelemetry Node SDK does), it receives them as they are.

- **`http.server.request.duration`**, a histogram in seconds with the bucket boundaries the HTTP semantic conventions advise, for every request, sampled or not. Attributes: `http.request.method`, `url.scheme`, `http.route` (when a handler matched), `http.response.status_code` and `error.type` (on the same rule as the span's error status). Requests under `ignore.routes` and the dashboard path are not counted.
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
