# @nestrix-js/ui

The prebuilt dashboard for [`@nestrix-js/nestjs`](../nestjs/README.md): a static single-page app (React, hash routing) that shows a Nest application's recent requests, trace waterfalls with their log lines, error groups, per-route statistics and latency histograms, classes, the app map, dependencies, slow queries, the process runtime and an on-demand CPU profiler. The same build is served by the standalone server, which adds SLO and API-token pages.

You do not import this package. Install it next to `@nestrix-js/nestjs`, at the same version, and `NestrixModule` finds it and serves it from inside your application:

```bash
pnpm add @nestrix-js/ui
```

How the dashboard is opened, secured and limited is documented in the [Dashboard section of the `@nestrix-js/nestjs` README](../nestjs/README.md#dashboard).

## What is in the package

- **No runtime dependencies.** Everything the app uses (React, TanStack Router, Query, Table and Virtual, Tailwind, uPlot, a self-hosted Geist Mono font) is bundled at build time. `package.json` has no `dependencies`.
- **Files only.** `dist/` holds `index.html`, hashed files under `dist/assets/`, `manifest.json` (every file in `dist/`, with its path, size, SHA-256 and content type; only `index.html` and `assets/` are served) and `THIRD_PARTY_NOTICES.txt`. The Node entry (`dist/index.js`) exports two URLs, `dashboardDirectory` and `manifestUrl`, and runs no code beyond that.
- **No inline script or style.** The app runs under a strict Content-Security-Policy (`default-src 'none'; script-src 'self'; style-src 'self'; ...`) that `@nestrix-js/nestjs` sets on every dashboard response.
- **Size.** About 918 KB unpacked at `0.1.0` (`npm pack --dry-run`), against a budget of 1.25 MB that CI enforces with `scripts/check-size.mjs` (decisions D-52, D-79).

## How `@nestrix-js/nestjs` uses it

`@nestrix-js/ui` is an optional peer dependency of `@nestrix-js/nestjs`. The module locates it when the Nest application is constructed, reads `manifest.json` and every listed file into memory at `onModuleInit`, and registers one exact route per file with the HTTP adapter. `index.html` is filled in per request with the dashboard's base path and a JSON config block. Source maps, type declarations, the Node entry and the notices file are not served.

The API the app reads is served by `@nestrix-js/nestjs`, not by this package. The app is built against the query-API types in the private `packages/protocol`.

## Design rules and the kit

Every page is built from the kit in `app/components/kit/` (import from `@/components/kit`, or a file in it). The Requests page (`app/views/requests/`) is the reference page; the Overview and the route detail page show the look. Do not write one-off cards, tiles or charts in a page: add to the kit.

### The rules

1. **One page header**: `PageHeader` with the title, one line saying what the page answers (no trailing period), the source ("counted before sampling" or "from sampled traces"), and on the right the page's controls.
2. **A KPI strip first** where the page has numbers: three to five `StatTile`s in a `KpiStrip`. Never invent a change the API does not give: pass `delta="—"`.
3. **Charts before tables.** Answer the page's main question with a chart; put the table below for detail.
4. **Tables**: `BarCell` for a value with a proportional bar, `Chip` for statuses (with words), monospace for numbers, routes, statements and ids, numbers right-aligned, sticky header (`containerClassName="max-h-[70vh]"` on `DataTable`), row hover, and the whole row clickable (`onRowClick`) when it opens something, with a real link kept inside the row.
5. **Colour** only from the tokens in `app/styles.css` (add a token there with light and dark values when needed). Worse is destructive or warning, better is success, neutral is muted. An arrow follows the sign and the colour says good or bad. Text must keep 4.5:1 contrast on its background in both themes: use `text-destructive-text`, `text-warning-text` and `text-info` for text, not `--destructive` or `--warning`.
6. **States**: `SkeletonKpiStrip`, `SkeletonChart`, `SkeletonList` or `DataTableSkeleton` while loading (shaped like the content, no spinners); `EmptyState` says how to get data; `ErrorState` says what failed and offers "Try again".
7. **Phone width (390 px)**: no horizontal page scroll. The section menu scrolls inside its own box, tables scroll inside their card, KPI strips are two columns on a phone.
8. **Accessibility**: real buttons and links, a label on every icon button, `role="img"` and an `aria-label` that states the takeaway on every chart, keyboard focus visible (the base layer in `styles.css` outlines anything focusable).
9. **No new runtime dependency**, and the package stays under its 1.25 MB budget (`scripts/check-size.mjs`, D-79).
10. **Tests**: keep unit and Playwright tests passing; add a screenshot pair per page, `p14-<page>-dark.png` and `p14-<page>-light.png` (and `p14-<page>-phone.png` where phone layout matters), written to `packages/ui/test-results/` by a Playwright test (see `e2e/p14-kit.pw.ts`); run `pnpm build && pnpm --filter e2e test` as well.

### The components

| Component | One line |
|---|---|
| `PageHeader` | `<PageHeader title="Requests" description="Every request, newest first" source="traces" controls={<SegmentedControl .../>} />` |
| `Section` | `<Section title="Latency" description="p50, p95, p99" source="from sampled traces" testId="card-latency" actions={...}>...</Section>`; `flush` lets a table touch the edges |
| `StatTile`, `KpiStrip` | `<KpiStrip columns={4}><StatTile testId="kpi-p95" label="p95" value="286" unit="ms" delta="+12%" deltaTone="worse" series={[...]} source="..." /></KpiStrip>` |
| `Delta` | `<Delta text="+12%" tone="worse" />` (the text carries the sign; "—" is unknown) |
| `Chip` | `<Chip tone="warn" icon={<Icon />}>404</Chip>`; tones `worse`, `better`, `neutral`, `info`, `warn`; always put words in it |
| `SourceLabel` | `<SourceLabel kind="traces" />` or `<SourceLabel>5xx or thrown</SourceLabel>`; `SOURCE_TEXT` has the standard wording |
| `Sparkline` | `<Sparkline values={[...]} label="Errors per bucket" />`: red bars, scaled to the largest |
| `TrendLine` | `<TrendLine values={[...]} color="--chart-1" label="p95 over the window" area stretch />` |
| `AreaChart` | `<AreaChart series={[{ id, label, color: "--chart-1", values }]} previous={[...]} markers={[...]} fromUnixMs toUnixMs format={formatDuration} label="..." stacked />` (SVG, lines or stacked areas, previous window in grey, vertical markers) |
| `BarChart` | `<BarChart items={[{ key, label, segments: [{ value, color: "--chart-1" }, { value: errors, color: "--destructive" }] }]} orientation="horizontal" label="..." />`; vertical for buckets over time, horizontal for rankings |
| `Donut`, `DonutLegend` | `<Donut slices={donutSlices(items, DONUT_RADIUS)} testId="donut-x" label="...">centre text</Donut>` and `<DonutLegend items={[{ key, label, color, value }]} />` |
| `Heatmap` | `<Heatmap rows={days} columns={hours} values={grid} label="..." />` (intensity from `heatLevel`) |
| `ScoreRing` | `<ScoreRing score={72} color="--warning" label="Health score 72 of 100" />` |
| `BarCell` | `<BarCell value={ms} max={slowest} label="245 ms" />` in a table cell |
| `SegmentedControl` | `<SegmentedControl label="Window" options={[{ value: 15, label: "15 min" }]} value={w} onChange={setW} />` |
| `EmptyState`, `ErrorState` | `<EmptyState title="No requests yet.">They appear here as the app handles them.</EmptyState>`, `<ErrorState title="Could not load requests." message={e.message} onRetry={reload} />` |
| `SkeletonKpiStrip`, `SkeletonChart`, `SkeletonList` | `<SkeletonKpiStrip count={4} />` while the numbers load |
| `Chart` | uPlot line chart for time series (`xs`, `series`, `format`, `label`); used by Routes and Runtime |

Pure helpers (all unit tested in `format.test.ts`): `barPercent`, `niceMax`, `compactNumber`, `stackHeights`, `heatLevel`, `heatOpacity`, `donutSlices`, `ringDasharray`, `linePath`, `areaPath`, `cumulativeSeries`.

The shell (`app/components/app-shell.tsx`) is the same everywhere: brand and service, the live state, the sampling notice, "Pause live", and the section menu. `PAGE_COLUMN` is the page width and gutters (`max-w-7xl`); pages render inside `main` and use `space-y-6` between their blocks.

## Third-party notices

`dist/THIRD_PARTY_NOTICES.txt` carries the licence text of every bundled package (MIT, ISC, Apache-2.0, and OFL-1.1 for the Geist Mono font) and of the code copied into the repository (shadcn/ui, tablecn and Dice UI components, all MIT). It ships in the package.

## Licence

[Apache-2.0](../../LICENSE)
