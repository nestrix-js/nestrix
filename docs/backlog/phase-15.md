# Phase 15 backlog: the data behind the redesigned pages

Owner, 2026-11-12: complete everything as soon as possible, in parallel, without stopping to ask. Phase 14 left honest gaps where the API has no data; this phase adds the data (additive, optional protocol fields only, so older clients and servers keep working) and shows it. Delivery mode (AGENTS.md). Nothing from `@nestjs/observe` (rule 8).

## Status

| ID | Task | Tier | Status |
|---|---|---|---|
| P15-01 | Previous-window changes for Dependencies, Classes, Map (both backends + UI tiles/rows) | sonnet | todo |
| P15-02 | Errors: release per group, New / Regressed / Ongoing / Quiet, weekday × hour heatmap, errors per release (both backends + UI) | sonnet | todo |
| P15-03 | Per-instance runtime in the standalone server through the check-in (SDK + server + Profiler "suggested instance") (D-80) | opus | done (branch `p15-03-instance-runtime`, not merged) |
| P15-04 | Docs: roadmap, AGENTS.md, phase reports 12–14, docs-site guides (route detail, large traces, redesign) | sonnet | todo |
| P15-05 | Merge, checks, review of P15-03, release | lead | todo |

## Decisions

- **D-80 (lead, delivery mode):** the standalone server learns each opted-in instance's runtime (CPU, event-loop delay p99, heap used, RSS) from an optional `runtimeSample` field on the existing check-in (`CheckInRequest`; named `runtimeSample` as built because `runtime` already carries the Node version), sent only when `export.profiler` is on. No metrics receiver. The Profiler page uses it for per-instance numbers and a "suggested instance" chip; instances without it show "—". A full OTLP `/v1/metrics` receiver stays out of scope.
- New protocol fields are optional; a UI that gets an older answer shows "—" as today.

## P15-03 as built

- **Protocol** (`packages/protocol/src/remote-profiles.ts`): `InstanceRuntimeSample` { `cpuPercent?`, `eventLoopP99Ms?`, `heapUsedBytes?`, `rssBytes?`, `sampledAtUnixMs` }, optional as `CheckInRequest.runtimeSample` and `InstanceSummary.runtimeSample` (`null` when the latest check-in had none). The brief's name `runtime` was taken: both types already use `runtime` for `process.version`, so reusing it would have broken old servers and clients.
- **SDK** (`packages/nestjs/src/profiler/check-in-runtime.ts`, used by `remote.ts`): CPU over the interval since the previous check-in, heap and RSS read at check-in time (about 2 µs per check-in, no timer). Event-loop p99 comes only from the embedded dashboard's `RuntimeSampler.latest()`, when that runs and its sample is at most 30 s old. An own histogram was measured and not added: `monitorEventLoopDelay({ resolution: 20 })` on an idle Node 26.13 process cost 13.7 to 14.8 ms of CPU per 10 s, against 2.4 to 2.7 ms without it, plus about 47 wake-ups per second. So instances without the dashboard send no loop figure. Every source is guarded (`profiler.remote.runtime` in diagnostics); a failure leaves the figure or the field out and the check-in goes ahead.
- **Server**: `parseRuntimeSample` (`apps/server/src/profiler/parse.ts`, `RUNTIME_BOUNDS`): per-figure drop, never a `400`. Migration `0011_instance_runtime.sql` adds five nullable columns to `instances`, written by the check-in's existing upsert (NULL when absent, so an older SDK clears them). `GET instances` returns them with the server's time of that check-in as `sampledAtUnixMs`; the instance's clock is not used.
- **UI**: the standalone Profiler page has CPU and Loop p99 columns (kit `BarCell`; CPU against one core, or the largest when above), a stacked Heap / RSS column, "—" for a missing figure, and a "Suggested" chip per service (`packages/ui/app/views/profiler/instance-runtime.ts`). The chip needs at least two instances of the service reporting the figure, and the top one at least 1.5 times the next and at least 10 CPU points (else loop p99: 20 ms) above it. CPU goes first. To fit at 1280 px without pushing the Capture button out, the chip sits under the instance id and the PID under the host ("Host / PID"); a Playwright check measures that the table does not scroll at 1280 px.
- **Tests**: `packages/nestjs/test/profiler-check-in-runtime-unit.test.ts` (arithmetic, freshness, fault injection), `profiler-remote.test.ts` (body carries the sample, absent cleanly, throwing reader and dashboard source), `profiler-remote-nest.test.ts` (the dashboard's p99 reaches the check-in on Express, Fastify and platform-node). Server: `apps/server/test/profiler/unit.test.ts` (validation, old clients) and `remote-profiles.test.ts` (storage, clearing, another key cannot overwrite). UI: `instance-runtime.test.ts`, `e2e/profiler-remote.pw.ts` (columns, "—", chip, older server, phone width) and the P14 standalone screenshot fixture.
- **Deferred:** the loop figure for instances without the embedded dashboard (needs the owner or lead to accept the histogram's cost, or a cheaper source); an OTLP metrics receiver (D-80).
