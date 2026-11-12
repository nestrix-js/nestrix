# Phase 12 report: route detail and "what changed"

Date: 2026-11-12. Written by the lead under delivery mode: local per-task checks, runs under about 3 minutes, CI on `main` as the safety net (`docs/backlog/phase-12.md`). Shipped in `0.2.0` with phase 13 and the own-time query fix in section 4.

## 1. Summary

When the Overview says a route got slower or fails more, one click now shows why. `GET api/v1/routes/explain` compares a route's traces on two sides, the previous window against the last (15 or 60 minutes) or one release against another, and returns per-side totals, own time by kind, statements, methods, dependencies, errors, the slowest traces, a one-sentence summary and ranked findings: a new or N+1 statement, a slower statement, dependency or method, dependency errors, a new or more frequent error, and what got faster. Both backends answer from one pure computation. A route detail page (`#/route`) shows it; each finding links to the Queries, Dependencies, Classes or Errors page already filtered. Every card says whether its numbers are counted before sampling (the KPI tiles and the histogram) or built from sampled traces (everything else, up to 2,000 traces per side), as D-61 requires.

## 2. Acceptance

| Check | Result | Evidence |
|---|---|---|
| Unit tests of the pure module: every finding fires, does not fire just under each threshold, `n-plus-one` takes precedence over `new-statement`, summary wording, fewer than 5 traces, release mode | **Met** | Tests of `packages/nestjs/src/explain/compute.ts`; the server's copy is checked byte for byte by `apps/server/test/query/explain.test.ts`. |
| One route test per backend: shape, `400` on one release, `service` on the server | **Met** | The same test files. |
| Span cap of 200,000 per side on both backends | **Met** | Explain cap tests on both backends. |
| Playwright on Chromium: slower route with an N+1 finding, release comparison, too few traces, unknown route, navigation from the Overview and the Routes page | **Met** | UI Chromium suite: 173 tests. |
| API tokens may read the route | **Met** | `routes/explain` is in the server's `TOKEN_READ_ROUTE`; the existing guard test covers it. |
| Whole workspace | **Met** | `pnpm verify`: 3,667 tests; app-level end-to-end (`pnpm --filter e2e test`): 18. The SQL was checked for bound parameters. |

## 3. What was done

| Task | Result |
|---|---|
| P12-00 | Protocol (`packages/protocol/src/route-explain.ts`), backlog. |
| P12-01 | `packages/nestjs/src/explain/compute.ts` (pure), `explain/embedded.ts`, the server's byte-identical `explain-compute.ts` and `explain.service.ts`. Newest 2,000 traces per side. |
| P12-02 | The route detail page and the links from the Overview, the Routes page and the trace view; `q`, `name`, `class` and `type` filters on Queries, Dependencies, Classes and Errors, each with a "Filtered by" chip. `Card` and `Delta` moved to shared components. |
| P12-03 | Review, README views table, changeset. Fixed on merge: a pg test that was flaky on random ports containing 42. |

## 4. A fix shipped in 0.2.0: own-time queries

A real deployment (server 0.1.1, Postgres at 0.5 CPU, one trace of about 4,700 spans: an upload whose BullMQ job joins the request's trace) made `GET /api/v1/overview` take 4 to 8 s and `/classes` 2 s.

- **Cause.** Own time summed each span's children with a `LEFT JOIN LATERAL`, and `spans` had no index on the parent, so every span re-read its whole trace: quadratic per trace.
- **Fix.** Migration `0009_spans_parent_idx.sql` (`spans (trace_id, parent_span_id)` on the partitioned parent, inherited by every daily partition), and one pass in `OverviewService.kindRows` and `QueryService.classes`: a CTE of the window's spans and a CTE summing children once per `(trace_id, parent_span_id)`, joined back. Dependencies and Map already used `EXISTS` or a join and only needed the index. The index cannot be built `CONCURRENTLY` on a partitioned table; `apps/server/README.md` ("Upgrading to 0.2.0") gives the pre-build recipe for large installs.
- **Clock skew.** Children are bounded by `start_time >= <window start> - 1 minute`, not by the parent's start, which dropped the children of a host with a slow clock and overstated own time. The bound still prunes old partitions.
- **Measured** on a 5,203-span two-service job trace, local Docker Postgres: overview **3,723 ms before, 72 ms after**; classes 197 ms before, 11 ms after. At 50,003 spans the overview took more than 60 s before (the test timeout) and **346 ms after**. `apps/server/test/query/own-time.test.ts` keeps the first as a test (both under 1,500 ms; `OWN_TIME_ROWS=5000` makes it 50,000 spans) and adds a child that starts 5 ms before its parent.

## 5. Reviews and findings

No independent model review of this phase: the work is read-only queries and a page, outside the host's request path. The lead's review (P12-03) checked the SQL for bound parameters, the README and the changeset. Defect found after merge: the flaky pg test, fixed. The own-time problem was found in production, not in review; it is the reason for section 4 and for the explain span cap.

## 6. Decisions

None new in `docs/decisions.md`. The calls the backlog left open are in its "As built (P12-01)" and "As built (P12-02)" sections: a database call appears both as a statement and as a dependency, so one change can raise two findings; a brand-new dependency or method uses the "slower" kinds with "is new" wording; "mainly" in the summary names the first finding in the direction of the change; in release mode `releases` are the route's own, newest first, at most 20.

## 7. Deferred and known limits

- Benchmarks of the explain query under load and with many open dashboards (D-72).
- The compare data has no histogram or p99, so the route page's histogram shows the current window only and the p99 tile has no change.
- "Queries per request" sums at most 20 statements, so it is a lower bound for a route with more.
- A single trace of more than 200,000 spans is not loaded by the server's explain (that side may be empty).
- The shell's section tabs were wider than a phone when the page shipped; phase 14 reworked the shell.
