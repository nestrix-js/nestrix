# Phase 14 report: a visual pass across every dashboard page

Date: 2026-11-12. Written by the lead under delivery mode (`docs/backlog/phase-14.md`). Goes out as 0.3.0 with the changeset `dashboard-redesign` (minor for `@nestrix-js/ui` and `@nestrix-js/nestjs`); the owner reviews dark and light screenshots of every page before release (P14-06).

## 1. Summary

The owner's remark after phases 11 and 12 was that only the Overview had been done properly ("the rest still plain"). Phase 14 rebuilds every other page to the Overview's standard on a shared kit. It is UI only: no protocol, backend or API change. Where the API has no data, the page shows what it has and "—", and the gap is listed in section 6 and picked up by phase 15.

Every page has the same shape: a page header (title, one line on what the page answers, the source label "counted before sampling" or "from sampled traces", the controls), a KPI strip, charts before tables, tables with inline bars, chips with words and sparklines, loading skeletons shaped like the content, and friendly empty and error states. Colours are tokens with light and dark values; arrows follow the sign and colour carries good or bad; the pages' own content holds at 390 px.

## 2. Acceptance

| Check | Result | Evidence |
|---|---|---|
| Existing unit and Playwright tests keep passing, selectors changed only where markup changed | **Met**, with one known failure | `e2e/errors.pw.ts` "renders the protocol fixture" expects "ago" but the fixture's age now reads "yesterday": a date-dependent test on the Errors page, not a regression from the redesign. |
| A dark and light screenshot per page | **Met** | `packages/ui/test-results/p14-<page>-dark.png` and `-light.png`, plus phone shots, from `e2e/p14-*.pw.ts` and, for the login page, `e2e/tests/server-login.pw.ts`. |
| No horizontal page scroll at 390 px | **Met** for each page's own content | Phone overflow checks in the `p14-*.pw.ts` specs. |
| Size budget | **Met** | D-79 raised it to 1.25 MB unpacked. Requests brought the package to 968,374 bytes and Routes, Classes and Map to 985,709 (`scripts/check-size.mjs`); the later tasks' sizes are in their own reports. |
| App-level end to end | Run per task | Each task ran `pnpm build && pnpm --filter e2e test`; see `docs/backlog/phase-14.md`. The final run is part of P14-06. |

## 3. What was done

| Task | Result |
|---|---|
| P14-01 | The kit (`packages/ui/app/components/kit/`: `PageHeader`, `Section`, `StatTile` and `KpiStrip`, `Delta`, `Chip`, `SourceLabel`, `Sparkline`, `AreaChart`, `BarChart`, `Donut`, `Heatmap`, `ScoreRing`, `BarCell`, `SegmentedControl`, empty, error and skeleton states), the shell, and Requests as the reference page. "Design rules and the kit" in `packages/ui/README.md`. The Overview's and route detail's parts were moved, not copied. New tokens `--info`, `--warning-text`, `--destructive-text` (text that holds 4.5:1 in both themes) and `--focus`. |
| P14-02 | Errors (grouped, with a state chip, events over time by type, a donut by type, errors by route) and Queries (KPI strip, slowest and most frequent as bar charts, an N+1 badge). |
| P14-03 | Routes (tiles, slowest by p95, a table with bars and changes), Classes (own time by kind) and Map (health by error rate and p95, edge width by volume, a keyboard-reachable node list, a side panel). |
| P14-04 | Dependencies (health cards, calls over time), Runtime (gauges with thresholds) and Profiler (four-way flame-graph origin: your code, `node_modules`, Node built-ins, V8; top functions; CPU by origin), embedded and standalone. |
| P14-05 | The trace view (summary card, bars by category), SLOs (budget rings, burn bars), Settings (a copy-once token card) and the standalone login page (presentation only: same form, messages and CSP, no script and no inline style). |
| P14-06 | Owner screenshot review, fixes, release: with the lead, not done yet. |

## 4. Reviews and findings

No independent model review: UI only, nothing on the request path, no API change. Each task was checked by its own tests and screenshots. Found and fixed along the way: the "worse" text of `Delta` and `Chip` was too light for 4.5:1 (new `--destructive-text`). Found and not fixed here: `components/ui/table.tsx` gives `TableRow` a border with no colour, so rows use `currentColor` (white in dark mode) on any page that does not pass `border-border`; the redesigned pages pass it, and the table component should do it.

## 5. Decisions

- **D-79**: the `@nestrix-js/ui` budget is 1.25 MB unpacked (was 1 MB): nine redesigned pages on a shared kit do not fit in 1 MB without stripping features, and 1.25 MB is still far below comparable embedded UIs (2.96 to 11.59 MB).
- The health thresholds on the Map (failing from 5% errors or p95 1 s, degraded on any error or p95 300 ms) and on Runtime (loop p99 20 and 50 ms, CPU 60% and 85% of a core, heap in use 75% and 90% of what V8 has allocated) are constants in code, not settings; the colours are the existing tokens.

## 6. Gaps where the API has no data

- **Previous-window changes** on Dependencies, Classes and Map (their answers carry no previous window): phase 15, P15-01.
- **Errors**: no release per group (so no "Regressed" state; New, Ongoing and Quiet are derived from the series), no weekday by hour heatmap, no errors per release, no share of requests: P15-02.
- **Standalone Profiler**: no "suggested instance" chip and no per-instance CPU or loop delay (`InstanceSummary` carries none): P15-03 (D-80).
- **Classes** have no time series, so no calls sparkline. **SLOs** return only the current 1 h and 6 h burn rates, so there is no burn-rate-over-time chart. The Profiler's "Compare with" needs a diff of two captures, which the API does not offer.
- Some ad-hoc empty and error states are still not the kit's `EmptyState` and `ErrorState`: route detail ("Could not explain this route"), parts of Classes, Queries, Dependencies, Map, Runtime and the standalone Profiler, and two one-liners in Requests.

## 7. Deferred

- Benchmarks and bundle-size work beyond the budget (D-72).
- The owner's screenshot review before the 0.3.0 release.
