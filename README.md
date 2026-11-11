# Nestrix

Open-source observability for NestJS 12+: Nest-aware OpenTelemetry traces, in a dashboard served by your own app or in the backend you already run.

> **Status: pre-release, phase 0.** Nothing is published and there is no package code yet. This repository currently holds the design, the research behind it and the plan of work. The API shown below is the intended shape, not something you can install today.

## What it is for

- **A local dashboard with nothing else to run.** Import one module and open `/_nestrix`: recent requests, their trace waterfall, errors, slow routes. No account, no collector, no database.
- **Standard OpenTelemetry out.** OTLP to Jaeger, Tempo, Grafana, Datadog or an OpenTelemetry Collector, with spans that understand NestJS: route templates, controllers, guards, message patterns.
- **No loader flags.** Built on NestJS 12's own instrumentation hooks and on the tracing events libraries now publish, so there is no `node --import` or `--experimental-loader` step.
- **Yours to run.** Apache-2.0. Send the telemetry wherever you like.

## Intended usage

```ts
import { Module } from '@nestjs/common';
import { NestrixModule } from '@nestrix/nestjs';

@Module({
  imports: [NestrixModule.forRoot({ serviceName: 'my-api' })],
})
export class AppModule {}
```

One more line in `main.ts` adds spans for controller methods and jobs (services, guards, pipes, interceptors and filters opt in):

```ts
const app = await NestFactory.create(AppModule, { instrument: NestrixInstrument });
```

## Planned support

| | |
|---|---|
| NestJS | 12.0 and later |
| Node.js | 22.15 and later |
| HTTP adapters | Express 5, Fastify 5, `@nestjs/platform-node` from 12.3.2 |
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
