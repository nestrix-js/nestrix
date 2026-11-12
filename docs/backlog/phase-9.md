# Phase 9 backlog: insights in the dashboard

Owner, 2026-11-12: build all ten improvements, fast. **Delivery rule for this phase:** no test run longer than about 3 minutes; agents run only the tests of what they touch (no full `pnpm verify`, no Docker end-to-end, Playwright on Chromium for new screens only). CI on `main` is the safety net. Design sources: our own debugging needs and open-source trace UIs; nothing from `@nestjs/observe` (D-18).

Every new number shown in the UI says whether it is counted before sampling (route and class statistics) or built from the stored, sampled traces (everything derived from spans), as D-61 does today. Each new query-API shape goes in a new file under `packages/protocol/src/` (types only), is exported from its index, is mirrored where `@nestrix-js/nestjs` serves it (`src/store/protocol-types.ts` + drift check), and is implemented by both backends unless the task says embedded-only.

## Status

| ID | Task | Tier | Status |
|---|---|---|---|
| P9-01 | Trace diagnosis (time by kind/class bar, critical path), duration bars in the request list, saved filters | sonnet | done (local checks) |
| P9-02 | Latency histogram per route with click-to-traces; compare two windows and two releases | sonnet | done (local checks; see [report](../phase-9-report.md)) |
| P9-03 | Queries page: slowest and most frequent statements across traces | sonnet | done (local checks) |
| P9-04 | Error groups (type + message + route) with counts, first/last seen, sparkline | sonnet | done (local checks) |
| P9-05 | Dependencies page (hosts, databases, Redis: calls, p95, errors, trend); request timeline chart above the list | sonnet | done |
| P9-06 | Runtime view: event loop delay, heap, RSS, CPU (embedded) | sonnet | done (local checks) |
| P9-07 | Logs next to the trace: embedded capture from `NestrixLogger`; server OTLP `/v1/logs` receiver and storage | opus | done (reviewed) |
| P9-08 | Reviews, docs, release | lead | done (P9-07 security-reviewed; released with phase 8 as `0.1.0-alpha.3`; report: [phase-9-report.md](../phase-9-report.md)) |
