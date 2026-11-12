# Phase 15 backlog: the data behind the redesigned pages

Owner, 2026-11-12: complete everything as soon as possible, in parallel, without stopping to ask. Phase 14 left honest gaps where the API has no data; this phase adds the data (additive, optional protocol fields only, so older clients and servers keep working) and shows it. Delivery mode (AGENTS.md). Nothing from `@nestjs/observe` (rule 8).

## Status

| ID | Task | Tier | Status |
|---|---|---|---|
| P15-01 | Previous-window changes for Dependencies, Classes, Map (both backends + UI tiles/rows) | sonnet | done (on branch `p15-01-prev-window`, not merged) |
| P15-02 | Errors: release per group, New / Regressed / Ongoing / Quiet, weekday × hour heatmap, errors per release (both backends + UI) | sonnet | todo |
| P15-03 | Per-instance runtime in the standalone server through the check-in (SDK + server + Profiler "suggested instance") (D-80) | opus | todo |
| P15-04 | Docs: roadmap, AGENTS.md, phase reports 12–14, docs-site guides (route detail, large traces, redesign) | sonnet | todo |
| P15-05 | Merge, checks, review of P15-03, release | lead | todo |

## Decisions

- **D-80 (lead, delivery mode):** the standalone server learns each opted-in instance's runtime (CPU, event-loop delay p99, heap used, RSS) from an optional `runtime` field on the existing check-in (`CheckInRequest`), sent only when `export.profiler` is on. No metrics receiver. The Profiler page uses it for per-instance numbers and a "suggested instance" chip; instances without it show "—". A full OTLP `/v1/metrics` receiver stays out of scope.
- New protocol fields are optional; a UI that gets an older answer shows "—" as today.

## P15-01 as built

Protocol (all optional, additive; `packages/protocol/src/types.ts` and `dependencies.ts`, mirrored in `packages/nestjs/src/store/protocol-types.ts` and checked by `store-protocol.test.ts`):

- `DependenciesResponse`, `ClassStatsResponse`, `AppMapResponse` gain `previousCovered?: boolean`, `note?: string | null` (as `routes/compare`) and `previousTotals?` (present only when covered): `DependencyPreviousTotals { dependencies, calls, errors, slowestP95Ms }`, `ClassStatsPreviousTotals { classes, calls, errors, totalMs, ownMs | null }`, `AppMapPreviousTotals { targets, calls, errors, slowestP95Ms }`. The totals cover every target, class or edge of the previous window, including ones with no calls now.
- `DependencyStats.previous?`, `ClassStats.previous?`, `MapEdge.previous?`: that row's numbers in the previous window, counted the same way. Absent when not covered, or when the row had no calls then ("new").
- An older server sends none of these; the UI shows "—" with "This server does not send a previous window".

Backends: the previous window is the same query for the window just before (`now` moved to the last millisecond before the current window's first bucket or minute), merged by key (dependency id, class name, `from>to` edge). Coverage: embedded, the process's statistics start (`RouteStatistics.sinceUnixMs`, `ClassStatistics.sinceUnixMs`) must be at or before the previous window's start, and `classes` additionally needs the previous window inside the 60-minute ring, so a 60-minute `classes` is never covered; standalone, `min(route_minutes.minute)` of the service must reach the previous window's start (the Overview's rule). Not covered: `previousCovered: false`, a `note`, nothing else. The embedded dependencies and map read the trace store, which is capacity-bound, so an evicted previous window reads as fewer calls (the same bias as the current window). Standalone `classes` own time for the previous window is bounded above by the window's end (`ownUntilMs`) so it does not average in current spans; the SQL is the existing one-pass own-time query run twice. The service filter for another service answers empty with no totals.

UI: tiles take their change from the totals (`dependency-changes.ts`, `class-changes.ts`, `map-changes.ts`, helpers in `views/previous-window.ts`): counts as a neutral percentage, error rate in points and durations (slowest p95, own time) in ms, both worse when they rise. With a name filter on Dependencies the tiles sum the rows' own `previous` instead of the answer's totals. Rows: a "p95 change" column on the Dependencies table and the Map's edge table, an "Avg change" column on the Classes table (method rows leave it empty); "new" when a row has no previous; "—" with the note as tooltip when not covered. On the Map the first tile shows a change only when the app calls targets (one service); with several services it has none.

Tests: embedded `store-dependencies`, `store-app-map`, `class-stats-unit`, `dashboard-previous-window` (handlers with a fixed clock: covered, 60-minute ring, young statistics, other service) and HTTP assertions in the existing dashboard tests; standalone `test/query/previous-window.test.ts` against Docker Postgres; UI `views/previous-window.test.ts`; Playwright `e2e/p15-previous-window.pw.ts` (screenshots `p15-*`). Not benchmarked: the standalone endpoints now run their query twice plus one `min(minute)` lookup.
