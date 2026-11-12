# Phase 14 backlog: a visual pass across every dashboard page

Owner, 2026-11-12: "why you only fix the overview ui, the rest still plain, ugly". Bring every page up to the Overview's standard (phase 11) and the design canvas (https://claude.ai/artifact/XSyY3dCaUsnSyys8ud8216), built directly; the owner reviews dark and light screenshots of every page before release. UI only: no protocol, backend or API changes (a page that needs data the API does not return shows what it has; list such gaps in the report instead of changing the API). Delivery mode (AGENTS.md). Design sources: our own canvas and the Overview; nothing from `@nestjs/observe` (rule 8).

## Status

| ID | Task | Tier | Depends | Status |
|---|---|---|---|---|
| P14-01 | Shared kit + shell + Requests (reference page) | sonnet | — | todo |
| P14-02 | Errors (canvas design) + Queries | sonnet | P14-01 | todo |
| P14-03 | Routes + Classes + Map | sonnet | P14-01 | todo |
| P14-04 | Dependencies + Runtime + Profiler (embedded and standalone; canvas design) | sonnet | P14-01 | todo |
| P14-05 | Trace view + SLOs + Settings + login and empty/error states | sonnet | P14-01 | todo |
| P14-06 | Screenshot review with the owner, fixes, changeset, release | lead | P14-02..05 | todo |

## Design rules (every page)

- **One page header** (`PageHeader` from the kit): title, a one-line description of what the page answers, the source label ("counted before sampling" / "from sampled traces"), and on the right the page's controls (window toggle, filters, actions). Same spacing on every page.
- **A KPI strip first** where the page has numbers: 3–5 `StatTile`s (value, unit, change against the previous window when the API gives it, a sparkline when a series exists). Never invent a change the API does not provide: show "—".
- **Charts before tables.** The main question of the page answered by a chart (bars, area, donut, heatmap); the table below for detail.
- **Tables:** inline visuals in cells — `BarCell` (value with a proportional bar), status/severity chips with words (never colour alone), sparklines, change chips; monospace for numbers, routes, statements and ids; right-aligned numbers; sticky header; row hover; the whole row clickable when it opens something.
- **Colour:** only the tokens in `app/styles.css` (add tokens there if needed, with light and dark values). Worse = destructive/warning, better = success, neutral = muted; arrows follow the sign, colour carries good/bad (phase 11 rule). Both themes must read well (contrast 4.5:1 for text).
- **States:** loading skeletons shaped like the content (not spinners), friendly empty states that say how to get data, error states that say what failed. Same components everywhere.
- **Phone width (390 px):** no horizontal page scroll; the section menu scrolls or collapses inside its own box; tables scroll inside their card; KPI strips wrap.
- **Accessibility:** real buttons and links, labels on icon buttons, SVG charts with `role="img"` and an `aria-label` that states the takeaway, keyboard focus visible.
- **No new runtime dependency** without stopping and reporting; keep `@nestrix-js/ui` under its 1 MB budget (`scripts/check-size.mjs`); today ~945 KB, so prefer reusing uPlot/SVG code already in the bundle.
- **Tests:** keep every existing unit and Playwright test passing (update selectors only where markup changed, never weaken assertions); add a Playwright screenshot pair (dark, light) per page into `packages/ui/test-results/` named `p14-<page>-dark.png` / `-light.png`; app-level e2e (`pnpm build && pnpm --filter e2e test`) must pass.

## P14-01 kit, shell and Requests

- **Kit** in `app/components/kit/` (move, do not copy, what the Overview and route detail already have: `overview-charts.tsx`, `route-detail-parts.tsx`, `card.tsx`, `delta.tsx`, `sparkline.tsx`): `PageHeader`, `Section` (card with title, description, source label, actions), `StatTile` + `KpiStrip`, `Delta`, `Sparkline`, `AreaChart` (series + optional previous series + markers), `BarChart` (horizontal and vertical, stacked), `Donut` + legend, `Heatmap` (rows × columns), `BarCell`, `Chip` (tone: worse/better/neutral/info), `EmptyState`, `ErrorState`, `Skeleton` variants, `SourceLabel`. Each with a short doc comment and unit tests for its formatting helpers. Overview and route detail switch to the kit with no visual change (their Playwright tests must still pass).
- **Shell:** consistent header (service picker, live state, time-range control where pages share it), section menu that does not overflow at phone width, focus styles, page container width and spacing used by every page.
- **Requests** as the reference page: header; KPI strip (requests, error rate, p95, slowest request in the window, from the data the page already loads); the timeline as an area/stacked chart with the existing drag-to-filter; rows with status chip, duration `BarCell` against the window's max, method/route monospace, release and user columns as today; filters in a tidy toolbar with the saved filters menu.
- Write a short `packages/ui/README.md` section "Design rules and the kit" summarising the rules above with the component list, so the other agents and future work follow it.

## P14-02 Errors and Queries

- **Errors** (canvas artboard "Error insights"): KPI strip (events, requests with an error, groups new in the window, groups resolved/quiet — only what the API supports; otherwise "—"); errors over time stacked by exception type; donut by type; groups table with state chips (New / Regressed / Ongoing derived from first/last seen and releases where the API allows; if not derivable, show first/last seen clearly instead), event counts, sparklines, share of requests; a weekday × hour heatmap if the stored data allows it from the groups' occurrences, else leave it out and note it; errors per release if the data allows. Keep the Grouped / Every event views and the `route`/`type` filters (phase 12).
- **Queries:** KPI strip (statements, total time, likely N+1 count, slowest mean); "Slowest" and "Most frequent" as horizontal bar charts; table with `BarCell` for total time and mean, calls per trace, an N+1 badge, example trace links; keep the `q` and `nplus` filters.

## P14-03 Routes, Classes and Map

- **Routes:** KPI strip (routes, requests/min, error rate, worst p95); a "top routes by p95" bar chart; table with p95 `BarCell`, error chip, sparkline, change vs previous window (from `routes/compare`), and the Details link (phase 12); keep the histogram panel and compare.
- **Classes:** KPI strip; donut of own time by class kind (controller, service, repository, guard/pipe/interceptor, processor, other — from the data's class kind); table with own-time `BarCell`, calls sparkline, errors chip; keep the `class` filter.
- **Map:** nodes coloured by health (error rate and p95 thresholds as tokens), edge width by call volume, a legend, a side panel on click with the node's numbers and links; keep the existing layout code.

## P14-04 Dependencies, Runtime and Profiler

- **Dependencies:** a health card per dependency (status dot by error rate/p95, kind icon, p95, error rate, calls, trend sparkline) in a responsive grid above a calls-over-time chart and the table; keep the `name` filter.
- **Runtime (embedded):** gauges or tiles for event-loop delay p99, heap, RSS, CPU with thresholds; area charts over time; clear empty state.
- **Profiler** (canvas artboard "Profiler"): flame graph coloured by origin (your code, `node_modules`, Node built-ins, V8) with a legend; top functions with self-time `BarCell`; a CPU-by-origin donut; in the standalone page, the instances table with a "suggested" chip for the instance with the highest CPU or loop delay only if the data is available (otherwise skip and note), capture states as a progress bar; recent captures with state chips.

## P14-05 Trace view, SLOs, Settings, login

- **Trace view:** a summary header (root name, duration, status chip, service, release, user, start time, span count, omitted spans from phase 13), the time-by-kind bar and critical path from phase 9 styled with the kit, waterfall rows with kind colours and clearer nesting, the logs panel styled consistently.
- **SLOs:** budget rings (as on the Overview) per SLO, burn-rate chart over time, status chips, consistent forms.
- **Settings:** API tokens in cards with clear create/revoke flows and copy-once token display.
- **Login page and every empty/error state** on the standalone server and embedded dashboard: consistent with the kit.
