# Phase 12 backlog: route detail and "what changed"

Owner, 2026-11-12: build the next screen from the design canvas (https://claude.ai/artifact/XSyY3dCaUsnSyys8ud8216, artboard "Route detail"). When the Overview says a route got slower or fails more, one click shows why: which statement, dependency, method or error explains the change, compared window against window or release against release. Delivery mode (AGENTS.md). Design sources: our own needs and that canvas; nothing from `@nestjs/observe` (rule 8).

The wire contract is `packages/protocol/src/route-explain.ts` (`routeExplainParams`, `RouteExplainResponse`). Both backends implement it. Every number on the page is built from sampled traces except the latency histogram and the KPI tiles taken from route statistics, and each card says which (D-61).

## Status

| ID | Task | Tier | Depends | Status |
|---|---|---|---|---|
| P12-00 | Protocol, this backlog | lead | — | done |
| P12-01 | `GET api/v1/routes/explain` on both backends, one shared computation | sonnet | P12-00 | done (local checks; see "As built (P12-01)") |
| P12-02 | UI: route detail page | sonnet | P12-00 | done |
| P12-03 | Review, docs, changeset | lead | P12-01, P12-02 | done (pnpm verify 3,667 tests, UI Chromium 173, app-level e2e 18; SQL checked for bound parameters; README views table, changeset; fixed on merge: flaky pg test on random ports containing 42) |

## Settled design

### Computation (P12-01)

As in phase 11: a pure module in `packages/nestjs/src/` that takes plain per-side aggregates and returns `RouteExplainResponse`, copied byte-for-byte into the server with a drift test (the pattern of `overview/compute.ts` and `apps/server/src/query/overview-compute.ts`). Each backend gathers, per side, the traces whose root is this route (`http.route` + method; `method` absent = all methods), and from their spans:

- **Sides.** Window mode: `before` = the previous `windowMinutes`, `after` = the last `windowMinutes`, aligned as `routes/compare`. Release mode: traces of the route with `service.version` = `releaseA` (before) and `releaseB` (after), anywhere in the store. `400` when only one release is given; `releases` lists the route's releases newest first (by latest trace).
- **Per side.** `traces`, mean and p95 root duration, error rate (root failed). Own time per span kind (same classification as the overview's `timeByKind`), divided by `traces`. Statements: group database spans by statement text (the same normalised text the Queries page uses, bind values never present), calls and total time per request and mean per execution. Methods: method spans by `Class.method`, calls and own time per request. Dependencies: client spans grouped as the Dependencies page groups them, calls, time per request, error rate. Errors: `exception.type` from exception events (or `Error`), traces per type, one example message. Slowest: the 10 slowest `after` traces with own time by kind.
- **Findings** (only when both sides have at least 5 traces; otherwise `findings` is empty and `summary` says `Not enough traces to compare (N before, M after).`):
  - `new-statement`: absent before (0 calls), ≥ 1 call per request after, and ≥ 5 ms per request after.
  - `n-plus-one`: calls per request after ≥ 3 and ≥ 2 × before (or before was 0 and after ≥ 3), regardless of per-call speed. Takes precedence over `new-statement` for the same statement (one finding per statement).
  - `slower-statement`: same calls (within 20%), mean per execution ≥ 1.5 × before and +≥ 5 ms per request.
  - `slower-dependency`: time per request ≥ 1.3 × before and +≥ 20 ms; `dependency-errors`: error rate up ≥ 5 points with ≥ 3 failed calls after.
  - `slower-method`: own time per request ≥ 1.5 × before and +≥ 10 ms.
  - `new-error`: a type with 0 traces before and ≥ 2 after; `more-errors`: traces with it ≥ 3 × before and ≥ 5 after.
  - `faster` (direction `better`): any statement, dependency or method whose time per request fell by ≥ 30% and ≥ 10 ms.
  - `deltaMs` = after − before time per request for timing findings; `shareOfChange` = `deltaMs` / (after mean − before mean) when that difference is ≥ 10 ms, clamped 0..1, else `null`. Sort: worse timing findings by `deltaMs` desc, then error findings, then `faster` by |deltaMs|; at most 8.
  - Titles are one plain sentence with numbers formatted like the UI (ms below 1 s, else seconds with one decimal; calls with one decimal), e.g. `A new statement runs 6.4 times per request (SELECT … FROM order_items WHERE order_id = $1), adding 214 ms.`, `api.stripe.com takes 1.1 s per request, was 640 ms.`, `PaymentGatewayError is new: 14 traces.`. Statements in titles are cut to 80 characters with `…`.
  - `link`: statement → `{ view: "queries", params: { q: <first 120 chars> } }`; dependency → `dependencies` with `name`; method → `classes` with `class`; error → `errors` with `route` and `type`. Check the UI's existing search params for those pages and use what they accept; say so in the report.
- **Summary.** `Mean time went from X to Y` + `; most of it is <kind label> time (+N ms)` when one kind explains ≥ 50% of the change + `, mainly <first worse finding, shortened>` when there is one; or `Mean time is about the same (X → Y).` when the change is under 10% and under 10 ms; error-only changes say `Errors went from A% to B%`.
- **Cost.** Bound the work: at most the newest 2,000 traces per side (say so in a code comment and in the response's labels if trimmed: add nothing to the contract; the UI states "from up to 2,000 sampled traces per side").
- **Tests.** Unit tests of the pure module for every finding (fires; just under each threshold; precedence of `n-plus-one` over `new-statement`), summary wording, fewer than 5 traces, release mode. One route test per backend (shape, `400` on one release, `service` on the server). Add the route to architecture route lists, and to the server's `TOKEN_READ_ROUTE` (API tokens read it; the existing guard test will fail if you forget).

### As built (P12-01)

- **Where it lives.** `packages/nestjs/src/explain/compute.ts` (pure, self-contained: types-only import of `@nestrix-js/protocol`, no import of the overview module), `explain/embedded.ts` (gathers from the store), `apps/server/src/query/explain-compute.ts` (byte-identical copy, drift test in `apps/server/test/query/explain.test.ts`) and `explain.service.ts` (SQL). Nothing public was widened. `routes/explain` is in `TOKEN_READ_ROUTE`.
- **Input to the computation.** Per trace: root facts and a list of spans already classified by the backend with its existing code (the overview's `timeKeyOf`, the Queries page's statement text, the Dependencies page's target grouping, `nestrix.class`/`nestrix.method` method spans, `exception` events), so the module does only arithmetic. The server skips a client span as a dependency when a child server span belongs to another service, as its Dependencies query does.
- **Sides.** Window mode uses the overview's minute-aligned windows (`before` = `[prev, cur)`, `after` = `[cur, now]`). Release mode: `before`/`after` `fromUnixMs`/`toUnixMs` are the first and last trace start of the side (0 when empty). `releases` are the route's own releases (not all releases), newest trace first, at most 20. The `windowMinutes` default is 60, as the protocol says.
- **Bound.** Newest 2,000 traces per side. Embedded: the scan keeps at most the newest 4,000 converted traces per side while it runs, the module cuts to 2,000. Server: `ORDER BY start_time DESC LIMIT 2000` per side, then the spans of those traces.
- **Judgement calls the design did not settle.** A database call appears as a statement and as a dependency (`postgresql orders-db`), so a new statement can also raise `slower-dependency` for its server; each is its own finding. A brand-new dependency or method uses `slower-dependency`/`slower-method` with "is new" wording. Rows sort by absolute change in ms, then `afterMs`, so a removed statement is not cut off. In the summary, "mainly" names the first finding of the same direction as the change (worse for a slowdown, `faster` for a speed-up). Error findings sort: `new-error`, `more-errors`, `dependency-errors` in the order found.
- **Finding links (params the UI pages must accept).** `queries` with `q` (the statement, first 120 characters), `dependencies` with `name`, `classes` with `class` (the class part of `Class.method`), `errors` with `route` and `type`. Today the Queries, Dependencies and Classes pages read no such parameters (only `windowMinutes`, `sort`, ...) and the Errors page reads `route` only: P12-02 must add `q`, `name`, `class` and `type` filters or the links land on the unfiltered page.

### UI (P12-02)

- New page `/route?method=&route=` (hash route), reached from: the Overview's insight links with `view: "route"` (update the Overview to link here), the routes table rows on the Overview, the Routes page (a "Details" link per row, keep the existing histogram panel), and the trace page's route. Breadcrumb `Overview / Routes / <METHOD route>`.
- Layout follows the canvas artboard: header with the route and a compare picker (`Previous window` 15/60 min, or two releases from `releases`); KPI tiles from route statistics (requests/min, p95, p99, error rate, each with its change; reuse `routes/compare` data) and "queries per request" from the explain response; the **What changed** card (`summary` + the findings list with direction icon, title, a bar for `shareOfChange`, and the link); the latency histogram (reuse the Routes page component, overlaid with the other side when the existing compare data allows; otherwise current only); **Where the time goes, per side**: two stacked bars from `kinds` with a legend; **Statements**, **Methods**, **Dependencies** tables (before/after per request with change); **Errors** by type; **Slowest traces** with per-trace kind bars linking to the trace page.
- Empty states: route unknown or no traces → friendly message; fewer than 5 traces on a side → the summary sentence and the tables without findings.
- Source labels on every card. Colours from tokens; worse red/amber, better green, never colour alone.
- **Tests:** unit tests for helpers; Playwright (Chromium) against the mock API with fixtures for a slower route (N+1 finding), a release comparison, too few traces, an unknown route; navigation from the Overview insight and from the Routes page. Keep the whole Chromium suite and the app-level suite (`pnpm --filter e2e test`, needs `pnpm build`) passing.

#### As built (P12-02)

- **URL.** `#/route?method=&route=` plus `windowMinutes` (15 default, 60), `compare=release` with `releaseA` and `releaseB`. `method` absent means every method. The Overview's `view: "route"` links (`params: { method, route }`) go to `/route` (`insightHref`); the Overview routes table, a "Details" column on the Routes page and a "Route details" link on the trace page use `routeDetailHref`. The Routes tab stays marked on `/route`.
- **KPIs.** Window mode: requests/min, p95, p99, error rate from `routes` statistics (before sampling), changes from the window `routes/compare` row; the comparison has no p99, so that tile shows no change. Without a method, the route's busiest method stands for it. Release mode: sampled traces, tiles from the explain `before`/`after` (traces, mean, p95, error rate). "Queries per request" sums the (at most 20) statements returned, so it is a lower bound when a route has more.
- **Histogram.** The Routes page component for the current window only (no overlay; the compare data has no histogram). In release mode its card says it shows the window, not the releases.
- **Release picker.** The first request is a window one, to learn `releases`; then the two newest are compared until the person picks.
- **Finding links** pass what `link.params` names, and the target pages now read it: Queries `q` (statement text contained in the row's, case-insensitive, whitespace folded; at most 120 characters), plus `nplus=true` for an `n-plus-one` finding; Dependencies `name` (exact); Classes `class` (exact); Errors `view=all&route&type`. Each page shows a "Filtered by" chip with Clear. The errors list API has no `type` parameter, so that filter applies to the errors already loaded ("Load older" still pages).
- **Shared components.** `Card` and `Delta` moved from the Overview page to `app/components/`.
- **Known, not mine.** The shell's section tabs are wider than a phone, so every page scrolls sideways at 390 px; the route page's own content does not (tested).
