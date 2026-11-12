# Phase 15 backlog: the data behind the redesigned pages

Owner, 2026-11-12: complete everything as soon as possible, in parallel, without stopping to ask. Phase 14 left honest gaps where the API has no data; this phase adds the data (additive, optional protocol fields only, so older clients and servers keep working) and shows it. Delivery mode (AGENTS.md). Nothing from `@nestjs/observe` (rule 8).

## Status

| ID | Task | Tier | Status |
|---|---|---|---|
| P15-01 | Previous-window changes for Dependencies, Classes, Map (both backends + UI tiles/rows) | sonnet | todo |
| P15-02 | Errors: release per group, New / Regressed / Ongoing / Quiet, weekday × hour heatmap, errors per release (both backends + UI) | sonnet | todo |
| P15-03 | Per-instance runtime in the standalone server through the check-in (SDK + server + Profiler "suggested instance") (D-80) | opus | todo |
| P15-04 | Docs: roadmap, AGENTS.md, phase reports 12–14, docs-site guides (route detail, large traces, redesign) | sonnet | todo |
| P15-05 | Merge, checks, review of P15-03, release | lead | todo |

## Decisions

- **D-80 (lead, delivery mode):** the standalone server learns each opted-in instance's runtime (CPU, event-loop delay p99, heap used, RSS) from an optional `runtime` field on the existing check-in (`CheckInRequest`), sent only when `export.profiler` is on. No metrics receiver. The Profiler page uses it for per-instance numbers and a "suggested instance" chip; instances without it show "—". A full OTLP `/v1/metrics` receiver stays out of scope.
- New protocol fields are optional; a UI that gets an older answer shows "—" as today.
