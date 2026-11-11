# Phase 1 report: headless tracing (0.1.0-alpha)

Date: 2026-11-11. Written by the lead for the owner at the phase 1 gate. Phase 2 does not start until the owner has reviewed this report.

## 1. Summary

A Nest 12 app with one module import now sends correct traces to any OTLP backend. Server spans with route templates, handler attribution and exceptions, outbound `node:http` and fetch/undici spans with `traceparent` propagation, OTLP/HTTP export through a bounded queue, sampling, privacy defaults and the `redact` hook, bounded shutdown flush, and `Span`/`withSpan` are built, tested on Express, Fastify and platform-node, and documented. Every piece of request-path code had an independent review; each review found real defects, all fixed before merge.

Nothing is published. `main` is ahead of GitHub by the phase 1 commits; the owner pushes.

## 2. Acceptance criteria (roadmap, phase 1)

| Criterion | Result | Evidence |
|---|---|---|
| A request through two example services appears in Jaeger as one trace with correct parent and child links and route names | **Met** | `pnpm --filter jaeger-example check` on `main`: service-a `GET /call/:id` (server) → `GET` (client) → service-b `GET /items/:id` (server), one trace, Jaeger 2.23.0 |
| The conformance suite passes on Express, Fastify and platform-node | **Met** | `packages/nestjs/test/conformance-*.test.ts`: every table row on 3 adapters at Nest 12.4.2, Express/Fastify 12.0.0, platform-node 12.3.2, Node 22.15 and 26. One cell skipped: header versioning on Fastify 12.0.0, where Nest's own adapter fails to boot (`FST_ERR_DUPLICATED_ROUTE`) |
| With the OTLP endpoint unreachable for a ten-minute load run, RSS levels off within a queue-derived bound, and p99 stays within 5% of the reachable run | **Met on memory; p99 inconclusive** (unreachable and hanging collectors: heap after GC +2.4 / +2.2 MB over a healthy control against an 8.07 MB allowance, no heap trend, RSS slope within control + 1 MB/min, at most 2 connections. The p99 control ran while another benchmark loaded the machine, so its p99 is not a valid baseline; the re-run was stopped by the owner to save cost) | `benchmarks/results/outage.md`; criterion as revised in backlog P1-13 (§4 below) |
| Install size and startup cost are measured and written into the README | **Met** | `benchmarks/results/install-size.md`, `startup.md`; `packages/nestjs/README.md` "Install size and startup cost" |

`pnpm verify` on `main`: build, publint and attw ("All good!"), `check-no-tla` passed, 1304 tests passed and 57 skipped (database tests skip without Docker), Biome clean apart from 7 existing warnings in spike files, `tsc -b` clean.

## 3. What was done

| Task | Check that showed it |
|---|---|
| P1-00 Backlog, public option types | `docs/backlog/phase-1.md`, `src/options.ts` |
| P1-01 Runtime dependencies | sdk-trace, resources, core, context-async-hooks 3.1.1; exporter 0.301.1; semconv 1.45.0 (D-41 budget); `pnpm verify` |
| P1-02 Module, options, diagnostics | 57 tests |
| P1-03 OpenTelemetry setup and export pipeline | otel tests; reviewed (7 fixes), plus the single-flight follow-up (reviewed, fuzzed counter invariant) |
| P1-04 Privacy helpers | 61 tests incl. a 3000-case property test; reviewed (no leaks found) |
| P1-05 `Span` / `withSpan` | 40 tests; reviewed (3 fixes) |
| P1-06/07 HTTP server spans, attribution, exceptions | http tests on 3 adapters and `@nestjs/testing`, Node 22.15 and 26; reviewed (doc and test fixes) |
| P1-08/09 Outbound `node:http` and fetch/undici | 134 outbound tests on Node 22.15, 24.22, 26.13; reviewed (7 fixes incl. a proxy-URL credential leak) |
| P1-10 Conformance suite | see §2 |
| P1-11 CI matrix and nightly | actionlint; jobs pass under `act`. **Not yet run on GitHub** (needs a push) |
| P1-12 Jaeger example | see §2 |
| P1-13 Benchmarks | see §2 and §5 |
| P1-14 CommonJS check | consume fixtures boot `forRoot` and read injected options, CJS on Node 22.15 and 26, ESM |
| P1-15 Documentation | package README (full reference), root README, architecture §7; samples typechecked and kept identical by a test; doc review (17 corrections) |

## 4. What changed from the plan

Decisions the lead made inside phase 1 (no owner decision table entry was touched):

- **Public API names** settled in the backlog "Public API" section; architecture §7 updated.
- **Outage pass criterion.** The roadmap's "RSS growth after the first minute within a queue-derived bound" was measured as peak minus one sample, which the healthy control alone scored at 20.7 MB. Replaced by: heap-after-GC plateau within a queue-derived allowance over a healthy control, heap slope < 0.5 MB/min, RSS slope ≤ healthy + 1 MB/min, at most two collector connections before shutdown (backlog P1-13).
- **One export in flight during an outage.** OpenTelemetry SDK 3.1.1's batch processor lets up to 30 exports overlap after a failure. Nestrix's exporter wrapper now reports success to the processor while counting the failure, so the processor serialises its exports and new spans wait in the bounded queue. Reviewed against the SDK source.
- **Body cancelled after the response head** is recorded as `nestrix.http.body = "cancelled"`, not an error.
- **`ignore.routes` strings match the path exactly; `ignore.outgoing` strings are a prefix of the recorded `url.full`.**
- **Process errors:** `uncaughtExceptionMonitor` only. architecture §4.2 had said an `unhandledRejection` listener records errors "without changing behaviour"; it does change it (the process no longer crashes), so it is not used.
- **Accepted behaviour change for traced methods** (architecture §4.3): a method that handles its own promise and returns it, with the caller ignoring the result, now produces an unhandled rejection. No public API can observe a promise without this or silencing real rejections.
- **Changesets in pre mode `alpha`**, so the next version is 0.1.0-alpha.
- **Orchestration** (owner, during the phase): Opus for first builds of request-path code and reviews; investigations and exact-list fix rounds on Sonnet; a fresh session per phase.

Facts that corrected the docs:

- Before Node 24.20, `writableFinished` does not reveal a delivery cut after the app ended; Nestrix uses the socket's state instead, verified on 22.15, 24.16 and 26.13.
- `HttpAdapterHost.init$` emits no value; read the adapter from the host.
- SDK 3 does not read `OTEL_RESOURCE_ATTRIBUTES` or `OTEL_SERVICE_NAME`; Nestrix parses them.
- On Node 22.15, the bundled undici publishes no end event for upgrade requests; a timer ends those spans.
- A host global interceptor that runs before Nestrix's can hide an exception from it; the docs say to import `NestrixModule` first.

## 5. Known limits and open items

- **Memory.** Nestrix keeps about 2.5–3.7 MB alive (heap after forced GC). Under load, RSS on macOS is about 75 MB higher than an uninstrumented app: about 12 MB is module loading (3.2 MB of it the OTLP exporter graph, loaded even with export off); the rest is V8 growing its young generation to the 64 MB ceiling because each traced request allocates about 3× more and more of it survives a scavenge (spans live as long as the request). V8 returns the space when idle; macOS RSS keeps counting freed pages (inferred; not measured on Linux). Not a leak; reducing per-request allocation is carried into phase 2. Install adds 19.4 MB, dominated by OpenTelemetry packages (`semantic-conventions` 9.6 MB is imported by the SDK itself, so replacing Nestrix's own imports saves nothing). Startup adds about 50 ms.
- **CI has never run on GitHub.** All jobs pass under `act`; the first push will show the real minutes and any runner differences.
- **Flaky spike tests.** Two phase 0 spike tests (`spikes/p0-s6`) fail intermittently under full-suite load (timing assertions); each passes alone. Not weakened; to be made robust.
- **platform-node** server spans lack response `content-type`/`content-length` (not readable through public API).
- **Unread bodies:** `node:http` ends at the response head on the next tick if nothing reads; fetch/undici after 30 s without body progress (on Node 22, from the head).
- **Several apps in one process** share the first app's export, sampling, resource, `redact` and outbound settings (documented).
- **Install size** is dominated by OpenTelemetry's own packages; the exporter graph (including sdk-metrics) loads even with export off.

## 6. Cost

The ten-minute outage benchmark ran three full passes (first measurement, after the single-flight fix, and a control re-run), about 35 minutes each with agents polling and reporting, and was the most expensive acceptance item of the phase for what it added after the first pass. `architect` (Opus) agents used about 41% of the session's usage. Both led to the rules now in `docs/ai/orchestration.md`: Opus for first builds and reviews only, investigations and exact-list fixes on Sonnet, short benchmarks at gates, a fresh session per phase.

## 7. What needs the owner

- **Review this report and decide whether phase 2 (embedded dashboard) starts.** Phase 2's task list is written at its start, in a fresh session.
- **Push `main`** when ready, so CI runs on GitHub for the first time (P0-03 and P1-11 both wait on that).
- Optional: whether to measure memory on Linux before quoting RSS figures publicly.
- **Proposed roadmap change:** from phase 2 on, gates use functional checks and short (2–3 minute) benchmarks; soak runs like the ten-minute outage test move to the release checklist. Your call; the roadmap is unchanged until you say so.
- Unchanged from phase 0: O-4 (MongoDB spans), O-5 (trademark search), the `@nestrix` npm organisation, the `CODE_OF_CONDUCT.md` contact, and when the repository goes public.

## 8. Carried into phase 2

- Profile and reduce per-request allocation in Nestrix's own code (generator in header iteration, unexplained `WeakSet`/`Map` allocations, request state lifetime). Sonnet, measured before and after.
- Load the OTLP exporter graph only when export is on (about 3 MB RSS, about 110 files, some startup).
- Make the two flaky spike tests robust.
- `benchmarks/package.json`: a `bench:memory` script.
