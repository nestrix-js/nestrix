# Phase 11 report: the Overview page

Date: 2026-11-12. Written by the lead under delivery mode: local per-task checks, runs under about 3 minutes, CI on `main` as the safety net (`docs/backlog/phase-11.md`).

## 1. Summary

The dashboard now opens on an Overview instead of the request list. It gives a health score with a one-sentence verdict, a **Needs attention** list and a **Getting better** list (routes, error groups, dependencies, and SLOs on the standalone server, compared with the previous window and ranked by impact), KPI tiles with their change (throughput, error rate, p95, Apdex, slowest dependency), latency percentiles with release markers, donuts for responses by status and where request time goes, throughput with errors, the Apdex split and the routes that changed most. The request list moved to `/requests`; an old link to `/` that carries request-list search parameters is redirected there. Both backends answer `GET api/v1/overview` from one computation. Every card says whether its numbers are counted before sampling or built from sampled traces (D-61). Shipped in `0.1.0` with phase 10.

## 2. Acceptance

| Check | Result | Evidence |
|---|---|---|
| Unit tests of every insight rule (fires, does not fire just under each threshold, severity boundaries), the health formula, summary wording, Apdex from histograms, an uncovered previous window | **Met** | `packages/nestjs/test/overview-compute-unit.test.ts` and `apps/server/test/query/overview.test.ts`. |
| One route test per backend: valid shape; `service` honoured on the server | **Met** | `packages/nestjs/test/overview-embedded.test.ts` and `apps/server/test/query/overview.test.ts`. |
| The server's copy of the computation matches the SDK's | **Met** | A byte-identity test in `apps/server/test/query/overview.test.ts`. |
| Playwright on Chromium: degraded, healthy, empty and uncovered fixtures; verdict, both lists, KPI deltas and donuts render; the `/` to `/requests` redirect | **Met** | 150 Chromium end-to-end tests passed. |
| The real-app end-to-end flow | **Met after a fix** | `e2e/tests/dashboard.pw.ts` assumed `/` was the request list; CI found it, and the main flow now checks the Overview first and then goes to Requests. |

Not run: a full `pnpm verify` locally (by the delivery rule).

## 3. What was done

| Task | Result |
|---|---|
| P11-00 | Protocol (`packages/protocol/src/overview.ts`), backlog. |
| P11-01 | `packages/nestjs/src/overview/compute.ts` (pure), the embedded route, the server route and its byte-identical copy `apps/server/src/query/overview-compute.ts`. |
| P11-02 | The Overview page, the `/requests` move with the redirect, and SVG donuts built on the charts the UI already used (no new dependency). |
| P11-03 | Review, the README views table, changeset `overview-and-remote-profiling`. |

Fixed on merge: API tokens could not read `overview` (the server did not list it among the routes a token may read), and the KPI change arrows now follow the sign of the change, with colour carrying good or bad.

## 4. Decisions

No new entry in `docs/decisions.md` beyond D-77 (the release itself). The judgement calls the backlog left open are recorded in its "As built (P11-01)" section: dependencies need 10 sampled calls in each window, a cleared error group needs 3 events before, `slo-burn` uses the 1 h burn rate, `route-errors` impact counts the failing requests, a cleared group uses kind `error-group-spike` with direction `better`, Apdex takes errors out of satisfied and tolerating in proportion, and "new" error groups are judged against the previous window's groups whether or not statistics cover that window.

## 5. Deferred and known limits

- **Benchmarks.** The cost of the overview query (the server builds it from `route_minutes` and sampled traces on each request, the embedded store from memory) was not measured; neither was its polling load with many open dashboards.
- Thresholds are fixed in code and listed in `docs/backlog/phase-11.md`; Apdex T is shown but not editable.
- Comparisons start once a full previous window is kept; before that the page shows "—" and says why.
- Not in this phase: the route "what changed" card, per-instance runtime in the standalone server (it needs a metrics receiver), and the redesigned Route detail and Errors screens.
- The optimisation pass stays deferred (D-72).
