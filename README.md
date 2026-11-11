# Nestrix

Open-source observability for NestJS 12+: Nest-aware OpenTelemetry traces, in a dashboard served by your own app or in the backend you already run.

> **Status: pre-release.** `@nestrix/nestjs` 0.1.0-alpha (tracing, OTLP export and the embedded dashboard) is the first thing to ship. The sections marked "planned" below are not available yet.

## What it is for

- **A local dashboard with nothing else to run.** Import one module, install `@nestrix/ui` and open `/_nestrix`: recent requests, their trace waterfall, errors, slow routes. No account, no collector, no database. Served by your own app, closed unless you open it: in development to your own machine, elsewhere behind a token or your own check.
- **Standard OpenTelemetry out.** OTLP to Jaeger, Tempo, Grafana, Datadog or an OpenTelemetry Collector, with spans that understand NestJS: route templates and controller handlers now; guards and message patterns are planned.
- **No loader flags.** Built on NestJS 12's own instrumentation hooks and on the tracing events libraries now publish, so there is no `node --import` or `--experimental-loader` step.
- **Yours to run.** Apache-2.0. Send the telemetry wherever you like.

## Quick start (0.1.0-alpha)

```bash
pnpm add @nestrix/nestjs @opentelemetry/api@~1.10.0
pnpm add @nestrix/ui   # optional: the dashboard
```

```ts
import { Module } from "@nestjs/common";
import { NestrixModule } from "@nestrix/nestjs";

@Module({
  imports: [NestrixModule.forRoot({ serviceName: "my-api" })],
})
export class AppModule {}
```

Spans are exported over OTLP when an endpoint is set, for example `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`; with none, nothing leaves the process. Requires OpenTelemetry JS SDK 3 (`@opentelemetry/api` 1.10). The [package README](packages/nestjs/README.md) has every option, the privacy defaults, `Span` and `withSpan`, Sentry and CommonJS notes.

With `@nestrix/ui` installed, start the app in development and open the link Nestrix logs (`Nestrix dashboard: http://localhost:3000/_nestrix/auth?token=...`). Serving it in production needs `ui: { enabled: true, auth }`; see the [Dashboard section](packages/nestjs/README.md#dashboard).

Planned, not available yet: spans for controller methods and jobs through `NestFactory.create(AppModule, { instrument: NestrixInstrument })`.

## Support

| | |
|---|---|
| NestJS | 12.0 and later |
| Node.js | 26.13 and later |
| HTTP adapters | Express 5 and Fastify 5 from Nest 12.0.0, `@nestjs/platform-node` from 12.3.2 |
| OpenTelemetry JS | SDK 3.x |

## Documentation

| | |
|---|---|
| [Architecture](docs/architecture.md) | What is being built and why |
| [Roadmap](docs/roadmap.md) | Phases and what each must prove |
| [Decisions](docs/decisions.md) | What has been decided, and what is still open |
| [Research](docs/research.md) | The verified facts the design rests on |
| [NestJS hooks](docs/nest-hooks.md) | The extension points Nestrix builds on |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Two things to know before you start: contributions are signed off under the [DCO](https://developercertificate.org/), and there is a clean-room rule about `@nestjs/observe`.

## Licence

[Apache-2.0](LICENSE).
