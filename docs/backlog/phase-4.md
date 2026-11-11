# Phase 4 backlog: microservices (0.3)

Objective, deliverables and acceptance: [roadmap.md](../roadmap.md#phase-4-microservices-03). How to run it: [ai/orchestration.md](../ai/orchestration.md) and the delivery mode in `AGENTS.md`. Facts: [nest-hooks.md](../nest-hooks.md) §5 (microservice hooks), architecture §4.2 rules, D-14, D-33, D-38. Runs in parallel with phase 3 (it depends only on phase 1); shared files (`core.ts`, `resolve-options.ts`, `options.ts`, `index.ts`) take small, self-contained edits and the lead merges.

## Status

| ID | Task | Tier | Depends on | Status | Notes |
|---|---|---|---|---|---|
| P4-00 | Backlog | lead | — | done | This file. |
| P4-01 | Spike, then build: handler spans, context extraction, dispatch-hook injection, client spans, helper | opus | P4-00 | done | Spike `docs/spikes/P4-S1.md`. Built in `src/microservices/`, tests in `test/microservices/` (TCP in process, hybrid fixture, microservice-only, faults). `emit` is hot (span at the call). Hybrid default needs the pre-request hook line. |
| P4-02 | End-to-end over TCP, Redis, NATS, Kafka, RabbitMQ with containers; hybrid-app fixture | sonnet | P4-01 | todo | MQTT 5 and gRPC if time allows, else documented as untested. |
| P4-03 | Review of P4-01 | opus reviewer | P4-01 | todo | Required (request path). |
| P4-04 | Documentation and phase report | sonnet + lead | all | todo | |

## Rules for every task

The phase 3 backlog's "Rules for every task" apply (worktree per task, `git commit -s`, guarded hooks, counted failures, `@opentelemetry/api` only, containers from a Vitest `globalSetup` that skips without Docker unless `CI` is set, changeset, local checks). `@nestjs/microservices` stays an optional peer: nothing in `src` may import it at module top level in a way that fails when it is absent (load lazily, or type-only imports).

## Public API (P4-01)

```ts
import { instrumentClient, nestrixPreRequestHook } from '@nestrix/nestjs';

// A client made outside DI (ClientsModule clients are instrumented automatically):
const client = instrumentClient(ClientProxyFactory.create({ transport: Transport.TCP, options }));

// A hybrid app: the module's global interceptor does not reach the microservice's handlers
// unless it inherits the app's config, so register the pre-request hook (D-38):
app
  .connectMicroservice(options, { deferInitialization: true })
  .registerPreRequestHook(nestrixPreRequestHook);
await app.startAllMicroservices();
```

No new module option. Span shape: architecture §4.2 "Microservices".

## P4-01 Spike, then build

**Spike questions** (answer each with a run, pass/fail, in `docs/spikes/P4-S1.md`, then update `nest-hooks.md` §5 and architecture):
1. Metadata on the server, per transport (TCP, Redis, NATS, Kafka, RabbitMQ; MQTT 5 and gRPC if cheap): where does the packet metadata injected by `ClientProxy.setOnDispatchHook` arrive, and how does a server-side hook or interceptor read it through public APIs (`TcpContext.getMetadata()`, `KafkaContext.getMetadata()`, headers on NATS/RMQ contexts, `setOnProcessingStartHook` context)?
2. Handler coverage: does the module-registered global interceptor (`APP_INTERCEPTOR`) reach `@MessagePattern` / `@EventPattern` handlers in a pure microservice and in a hybrid app (`connectMicroservice` with and without `inheritAppConfig`)? If not, does a pre-request hook (`registerPreRequestHook`, with `deferInitialization: true`, D-38) or the server processing hooks give the needed coverage, and what must the user write?
3. Client span timing: wrapping `send` / `emit` on client instances found through `DiscoveryService` (public) — when does the span end for `send` (first value, completion, error, unsubscribe) and for `emit` (cold observable: a span only when subscribed)? Does the dispatch hook run inside the caller's context so injection sees the right span?
4. Clients created with `ClientProxyFactory.create()` outside DI: the helper shape (`instrumentClient(client)`).

**Build** (after the spike; deviations from below are recorded in the spike file and decisions.md):
- Server: a CONSUMER span (`@EventPattern`) or SERVER span (`@MessagePattern`) per handled message, named `<transport> <pattern>`, parented on the extracted context, ended when the handler's observable completes or errors; exception recorded; `messaging.system`, `messaging.destination.name` (pattern), `messaging.operation.type` (`process`), `rpc.*` where they fit (current semantic conventions).
- Client: dispatch-hook injection of W3C context into packet metadata (one hook slot: detect another hook already set where possible, and warn per D-33's spirit); PRODUCER (`emit`) / CLIENT (`send`) spans by wrapping `send` / `emit` on DI clients (copy `name`/`length`, never `Proxy`, idempotent) and the helper for non-DI clients.
- Microservice-only apps (no HTTP adapter) work.
- Tests with in-process transports (TCP at least) and a hybrid fixture; the full container matrix is P4-02.

## P4-02 End-to-end matrix

For each transport: a client app and a server app (or one hybrid process with two microservices), one HTTP request → `send` and `emit` → handlers; assert a single connected trace with correct parent/child links and kinds. Containers: Redis 8, NATS 2, Kafka (apache/kafka, KRaft), RabbitMQ 4 (verify tags). Under about 2 minutes in total; a file per transport.

## P4-04 Documentation and report

README microservices section (what is automatic, the hybrid-app line if needed, `instrumentClient`, transports tested), architecture and nest-hooks brought in line, `docs/phase-4-report.md`.
