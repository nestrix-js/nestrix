# Compatibility

| | Supported |
|---|---|
| Node.js | 26.13 and later |
| NestJS | 12 |
| `@nestjs/platform-express`, `@nestjs/platform-fastify` | from 12.0.0 |
| `@nestjs/platform-node` | from 12.3.2 (12.3.0 and 12.3.1 lose the request context after JSON body parsing) |
| OpenTelemetry JS | SDK 3 only, with `@opentelemetry/api` 1.10 (peer range `>=1.10.0 <1.11.0`) |
| Module format | ESM-only; CommonJS Nest 12 apps load it with `require()` |

## Adapters

HTTP spans, the dashboard and metrics work on Express, Fastify and `@nestjs/platform-node`. Known limit: on `@nestjs/platform-node`, the `Content-Type` and `Content-Length` response headers are missing from server spans.

Header versioning with two versions of one route does not boot on Fastify with Nest 12.0.0. That is Nest itself, not Nestrix.

An app with no HTTP adapter (a pure microservice) boots; it has no HTTP spans and no dashboard, and its message handlers are traced.

## Libraries

Tested against:

| Library | Version | Default |
|---|---|---|
| `pg` | 8.23 | on |
| `mysql2` | 3.24 (3.20 or later needed) | opt-in |
| `ioredis` | 6.0 (5.11 or later needed) | opt-in |
| BullMQ with `bullmq-otel` | 6.7 and 2.0 | through BullMQ's own telemetry |
| `@nestjs/microservices` | 12.4 | automatic when installed |

Microservice transports tested end to end: TCP, Redis, NATS, RabbitMQ, Kafka, MQTT 5. See [Microservices](/guide/microservices).

## Testing

Under `@nestjs/testing`, HTTP spans work; method spans do not.

## CommonJS apps

- Jest needs `node --experimental-vm-modules node_modules/jest/bin/jest.js`. Vitest works unchanged.
- AWS Lambda disables `require(esm)` on its Node 20, 22 and 24 runtimes; set `NODE_OPTIONS=--experimental-require-module`.
- Upstream `@opentelemetry/instrumentation-*` instances must be constructed after `NestFactory.create`.
- Call `trace.getTracer()` inside the function that creates the span, not at module top level, or the tracer stays a no-op.

## Optional packages

| Package | Needed for |
|---|---|
| `@nestrix/ui` (same version as `@nestrix/nestjs`) | the embedded dashboard |
| `@nestjs/microservices`, `pg` | microservice and `pg` spans |
| `@opentelemetry/sdk-logs`, `@opentelemetry/exporter-logs-otlp-http` | `logs.export` |
| `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http` | metric export |
| `bullmq-otel` | BullMQ job traces |

## Install size and startup

Measured on one machine (darwin-arm64, Node 26.13, against an Express example): the packed `@nestrix/nestjs` tarball is 169 kB; installing it into a Nest host added 19.8 MB on disk including `@opentelemetry/api`; startup added about 33 to 50 ms. `@nestrix/ui` adds a 255 kB tarball and no dependencies. Numbers differ on your machine.
