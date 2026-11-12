# Phase 9 report: dashboard insights

Date: 2026-11-12. Written by the lead under delivery mode with the phase's own rule: no test run longer than about 3 minutes, agents ran only the tests of what they touched, and CI on `main` was the safety net (`docs/backlog/phase-9.md`).

## 1. Summary

The dashboard went from listing what happened to explaining it. Traces say where the time went and what the critical path is; routes have a latency histogram and can be compared across windows or releases; a Queries page shows the slowest and most repeated statements, errors are grouped, a Dependencies page shows what the app calls, a request timeline sits above the list, and an embedded Runtime view shows event loop delay, memory and CPU. Log lines now sit next to the trace (D-75, amending D-19). Every new number says whether it is counted before sampling (route and class statistics) or built from the stored, sampled traces. Released as `0.1.0-alpha.3` with phase 8.

## 2. Acceptance

The phase file states a delivery rule and a status table but no separate acceptance list; each task was accepted by the tests and Playwright checks of the screens it added, run locally on Chromium.

| Check | Result | Evidence |
|---|---|---|
| Each new query-API shape has a types file in `packages/protocol/src/`, is mirrored in `@nestrix-js/nestjs` with a drift check, and is implemented by both backends (embedded-only where stated) | **Met** | `packages/protocol/src/` (`queries`, `dependencies`, `runtime`, ...), `packages/nestjs/src/store/protocol-types.ts` and its drift check, `apps/server/src/query/`. |
| The real-app end-to-end check opens the Errors page grouped, then the flat list | **Met** | `e2e/tests/dashboard.pw.ts` (added after the real-app run found the grouped default). |
| Logs next to the trace in both modes | **Met** | `packages/nestjs/test/logs/trace-logs.test.ts`, `apps/server/test/query/trace-logs.test.ts`. |

Not run for this phase: a full `pnpm verify` and the Docker end-to-end (by the delivery rule). The documentation sweep that wrote this report ran only docs checks.

## 3. What was done

| Task | Result |
|---|---|
| P9-00 | Backlog (fast delivery). |
| P9-01 | Trace diagnosis (time by span kind and class, critical path), duration bars in the request list, saved filters. |
| P9-02 | Latency histogram per route (a click opens the list for that range), Compare tab (two windows, or two releases), `maxDurationMs` trace filter. |
| P9-03 | Queries page and `GET api/v1/queries` (embedded store and standalone SQL). |
| P9-04 | Error groups (type, normalised message, route) with counts, first and last seen, sparkline. |
| P9-05 | Dependencies page, request timeline chart above the list. |
| P9-06 | Runtime view: event loop delay, heap, RSS, CPU, sampled every 10 s, 60 minutes kept (embedded only). |
| P9-07 | Logs next to the trace: embedded capture from `NestrixLogger` (8 KiB cap, 200 per trace, after the logger's `redact`), server `/v1/logs` receiver and day-partitioned `logs` table, a Logs panel in the trace view, `GET api/v1/trace/logs`. |
| P9-08 | Reviews, docs, release. |

Also: the Jobs filter now means traces with job processing (`TraceSummary.hasJob`, a `has_job` column, a job badge), and the Classes view reports `methodsState` (`off`, `on`, `no-data-in-range`) so an idle service is not shown as having method spans switched off.

## 4. Reviews and their findings

- **P9-07 (logs, security review).** Log lines written in the same millisecond collapsed into one; repeated lines are now kept. The server's log writes could take advisory locks in different orders; they now lock in a fixed order. Entries known only by log lines are capped at 10% of `store.maxTraces` and do not count toward it, and `ui.logs: false` switches embedded capture off (added in the same fix round).
- **Classes three-state fix.** An idle service with method spans on was shown as "method spans are off". The API now reports three states, and the UI and the MCP explain "no data in this range".
- **Real-app end-to-end.** Running the dashboard against a real app showed that the Errors page opens grouped by default, which the earlier checks did not expect; the Playwright test now checks the group, then the flat list.

## 5. Decisions

D-75: logs are kept only as context for a trace (amends D-19). D-73 and D-74 belong to phase 8.

## 6. Deferred and known limits

- No full `pnpm verify` and no Docker end-to-end for this phase; CI on `main` is the check.
- Runtime and Profiler are embedded only; the standalone server cannot see the processes. Alert rules still have no UI; SLOs have a page.
- Logs are context for a trace only: no search across lines, no lines without a trace, no log-only views. Log text is free text and is cleaned only by the logger's `redact`.
- Insights built from stored traces (histogram links, release comparison, queries, dependencies, map, error groups) are sampled and, in the embedded store, limited to what fits in `store.maxTraces` and `store.maxBytes`; the embedded Queries scan has a statement cap and reports `truncated` when it stops early.
- The optimisation pass (benchmarks, soak runs) stays deferred (D-72).
