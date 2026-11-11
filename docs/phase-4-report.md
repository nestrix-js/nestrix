# Phase 4 report: microservices (0.3)

Date: 2026-11-11. Written by the lead under delivery mode (no approval stops; functional checks, local only).

## 1. Summary

One trace now crosses Nest services over Nest's own transports. Handler spans cover `@MessagePattern` (SERVER) and `@EventPattern` (CONSUMER), parented on context carried in packet metadata, which Nestrix injects through `ClientProxy.setOnDispatchHook`; client spans come from wrapping `send` (CLIENT) and `emit` (PRODUCER) on clients found through the public `ModulesContainer`, with `instrumentClient()` for clients created outside dependency injection. Microservice-only apps and hybrid apps with `inheritAppConfig: true` need nothing; a default hybrid app adds one line (D-68).

## 2. Acceptance criteria (roadmap, phase 4)

| Criterion | Result | Evidence |
|---|---|---|
| End-to-end tests over TCP, Redis, NATS, Kafka and RabbitMQ, with containers, each produce a single connected trace | **Met** | `packages/nestjs/test/microservices-e2e/` (redis:8, nats:2, apache/kafka 4.1.0 KRaft, rabbitmq:4): one `GET` → `send` and `emit` → handlers; exactly five spans in one trace with the expected parents, kinds, names and `messaging.system`. About 18 s for all files. |
| MQTT 5 and gRPC tested if time allows, otherwise documented as untested | **MQTT 5 met; gRPC untested** | `mqtt.test.ts` (eclipse-mosquitto:2, `protocolVersion: 5`). gRPC has no `send`/`emit` and no server-side `getMetadata()`; documented as untested. MQTT 3 carries no metadata. |

Validation: the end-to-end tests above; the hybrid-app fixture in `test/microservices/hybrid.test.ts` (default, `inheritAppConfig`, and the pre-request hook).

## 3. What was done

| Task | Result |
|---|---|
| P4-01 | Spike (`docs/spikes/P4-S1.md`, every transport run) and build in `packages/nestjs/src/microservices/`. Findings: metadata arrives via `getMetadata()` on all six transports; the module's global interceptor does not reach handlers in a default hybrid app; `emit` is hot (dispatches without a subscriber), correcting D-38's premise. |
| P4-02 | Five-transport end-to-end matrix plus MQTT 5. |
| P4-03 | Review. Fixes: a dispatch hook the host had already set was replaced (now kept, with a warning, and no propagation for that client); RPC root spans were typed `http` in the dashboard (now `other`); RPC tracing respected a disabled second app; an invalid `emit` is marked as an error. |
| P4-04 | README microservices section; architecture and nest-hooks §5 in line. |

## 4. Decisions

D-68: hybrid apps add `{ deferInitialization: true }` and `.registerPreRequestHook(nestrixPreRequestHook)`; setting the servers' processing hooks through `getRpcTargetRegistry()` (no user code) was not taken, because those hooks are a single unreadable slot and are not told the handler, the kind of message or the error.

## 5. Deferred and known limits

gRPC, mixed MQTT 3/5, NATS servers without headers, Kafka `emitBatch` and custom transports are untested. Clients registered by lazily loaded modules, or used before Nestrix's `onModuleInit`, need `instrumentClient`.
