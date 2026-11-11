# Phase 3 report: providers, data and jobs (0.2)

Date: 2026-11-11. Written by the lead under delivery mode (owner, 2026-11-11: no approval stops; minimal functional checks, local only; benchmarks deferred).

## 1. Summary

A trace now explains where the time went inside a request. With one line in `main.ts` (`instrument: NestrixInstrument`), the app's own controllers, services, repositories and queue processors get method spans, without a `Proxy` and without touching prototypes; scheduled methods start their own linked root traces. `pg` queries are traced by default (including nested copies an ORM loads at import or startup); `mysql2` and `ioredis` are opt-in. BullMQ jobs appear in the same trace as the request that enqueued them. The dashboard gained a classes view (calls, errors, total and own time per class and method, counted before sampling), an app map, slow-query highlighting and repeated-query grouping, links between traces, releases and users. Every request-path task had an independent Opus review; each found real defects, all fixed before the task was marked done.

## 2. Acceptance criteria (roadmap, phase 3)

| Criterion | Result | Evidence |
|---|---|---|
| A request that runs three queries and enqueues a job shows all of them under the right parent; the job's processing appears as a linked trace | **Met, with one difference** | `packages/nestjs/test/e2e-phase3/jobs.test.ts` (real Postgres 18 and Redis 8): three `pg` spans under `OrderRepository.load`; BullMQ's producer span under `OrderService.place`. BullMQ (`bullmq-otel` 2.0.1) makes the job's processing a **child** in the same trace, not a separate linked trace; the processor's method span (`nestrix.entry = 'job'`) is under it. The docs describe what BullMQ does. |
| A route with a method-level guard still returns 403 with `NestrixInstrument` on, on all three adapters | **Met** | `test/methods/` guard tests on Express, Fastify and platform-node, static and request-scoped controllers; removing the metadata copy fails 15 tests (mutation check). |
| Classes with `#private` members, request-scoped providers, providers holding callable objects, and plain function middleware behave exactly as without instrumentation | **Met** | The awkward-class corpus in `test/methods/awkward.test.ts`, compared as a whole against an uninstrumented run; review added a class stored on a prototype (`new this.Item()`). |
| Benchmark deltas for level 2 at sample rates 1 and 0.1 are published | **Deferred** | Delivery mode. Measured in unit tests only: a switched-off wrapper costs about 30 ns per call, an unsampled traced call about 70–95 ns (P0-S6). |

Validation: the awkward-class corpus is a fixture; integration tests run against real Postgres, MySQL and Redis containers (`test/integrations/`, started by a Vitest `globalSetup`, skipped without Docker unless `CI` is set).

## 3. What was done

| Task | Result |
|---|---|
| P3-00 | Backlog, option types, method-call sink, query-API types for classes and map; D-58 to D-63. |
| P3-01 | `pg` (wrapper, per-call pool token via `Object.create(config)` after review), `mysql2` and `ioredis` channel subscribers, SQL sanitiser (about 60 adversarial inputs, nothing leaked; unbalanced input fails closed). D-50 timing verified in a real Nest app: the constructor and `onApplicationBootstrap` scans catch every case except a `pg` copy first loaded during a request (documented). Review fixes: cross-request token theft with shared statement objects; `EVAL`-family scripts recorded. |
| P3-02 | Level 2 wrappers ported from P0-S6; own-class rule (D-58, amended by D-67); entry methods (D-62); enhancer spans opt-in. Review fixes: classes stored on prototypes, `@Global()` root modules, several apps per process, `*Service` classes with enhancer-like method names, weak plan references; D-67 (2): no span for non-entry methods outside a trace. |
| P3-03 | `serviceVersion` (D-63), opt-in `user` (verified per adapter: Fastify passes the `FastifyRequest`), trace `type`, list filters. Review fixes: numeric versions, 255-character releases, a `redact` test. |
| P3-04 | Pre-sampling class statistics and `GET api/v1/classes`. |
| P3-05 | App map and `GET api/v1/map` from the stored traces. |
| P3-06 | Classes and map views (SVG, no new packages). |
| P3-07 | Slow queries (> 100 ms), repeated statements (3+), span links, release/user/type in the request list. `@nestrix-js/ui` 783 KB of 1 MB. |
| P3-08 | BullMQ acceptance test and documented setup (`new BullMQOtel({ tracerName })`). |
| P3-09 | Reviews of P3-01, P3-02, P3-03 (and the follow-up fix rounds). |
| P3-10 | README and design docs for level 2, level 3, BullMQ, users, releases, classes, map. |

## 4. Decisions taken by the lead (delivery mode)

D-58 (own classes from static module metadata), D-59 (database spans cover the query only), D-60 (root Redis commands dropped), D-61 (exact counts before sampling; own time and the map from sampled traces), D-62 (entry methods), D-63 (release chain), D-67 (D-58 as built; no method span outside a trace). Each is in `docs/decisions.md` with its evidence.

## 5. Deferred, not failed

- Level 2 benchmark deltas at sample rates 1 and 0.1.
- mysql2's fuller context fix (needs Nestrix to own the context manager); `ioredis:batch` and `ioredis:connect`; pg's native client.
- Real MikroORM in the timing check (a stand-in with a nested `pg` copy was used).

## 6. Known limits (documented)

A `pg` copy first loaded during a request is not traced. A user's own dynamic module (`forRoot`) and statically imported library modules such as `HttpModule` are not traced unless included. The promise returned by a traced method must be handled by its caller (architecture §4.3). Level 2 does not apply under `@nestjs/testing` (D-48).
