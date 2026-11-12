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
- **Size.** About 918 KB unpacked at `0.1.0` (`npm pack --dry-run`), against a budget of 1 MB that CI enforces with `scripts/check-size.mjs` (decision D-52).

## How `@nestrix-js/nestjs` uses it

`@nestrix-js/ui` is an optional peer dependency of `@nestrix-js/nestjs`. The module locates it when the Nest application is constructed, reads `manifest.json` and every listed file into memory at `onModuleInit`, and registers one exact route per file with the HTTP adapter. `index.html` is filled in per request with the dashboard's base path and a JSON config block. Source maps, type declarations, the Node entry and the notices file are not served.

The API the app reads is served by `@nestrix-js/nestjs`, not by this package. The app is built against the query-API types in the private `packages/protocol`.

## Third-party notices

`dist/THIRD_PARTY_NOTICES.txt` carries the licence text of every bundled package (MIT, ISC, Apache-2.0, and OFL-1.1 for the Geist Mono font) and of the code copied into the repository (shadcn/ui, tablecn and Dice UI components, all MIT). It ships in the package.

## Licence

[Apache-2.0](../../LICENSE)
