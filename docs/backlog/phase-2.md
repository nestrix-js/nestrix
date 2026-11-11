# Phase 2 backlog: embedded dashboard (0.1.0)

Objective, deliverables and acceptance: [roadmap.md](../roadmap.md#phase-2-embedded-dashboard-010). How to run this backlog: [ai/orchestration.md](../ai/orchestration.md). The design is in [architecture.md](../architecture.md) §4.6, §4.7, §4.8 and §6, decision D-52 (frontend packages and the size budget) and D-45/D-46 (mounting, startup token). The evidence for mounting is [spikes/P0-S5.md](../spikes/P0-S5.md); its code under `spikes/p0-s5/` (`src/dashboard.ts`, `isLocalRequest()`) is the reference for raw writes, CORS stripping and the loopback rule.

## Status

Update this table as work moves. One line of notes at most; detail goes in the task's section.

| ID | Task | Tier | Depends on | Status | Notes |
|---|---|---|---|---|---|
| P2-00 | Backlog, public option types | lead | — | done | This file; `ui` and `store` in `src/options.ts` (types only, not yet read). |
| P2-01 | Query API v1 types, parameter specs, fixtures | sonnet | P2-00 | done | 12 tests + 7 type-level drift checks (run by the package build). MetaResponse, ErrorItem, RouteStats shapes and param bounds chosen by the agent; P2-03/P2-06 confirm them. |
| P2-02 | UI foundation: build, size budget, CSP, nuqs under hash history | sonnet | P2-00 | done | 548 KB unpacked (budget 1 MB); CSP clean in Chromium+Firefox at a non-root base; nuqs via an in-repo adapter (D-53, owner). |
| P2-03 | In-memory store and `nestrixSpanProcessor()` | opus | P2-01, P2-14 | done | Reviewed; fixes: drain under suppress-tracing (a span-creating `redact` hung flush), two-byte string cost, duplicate processors, poll `reset`, error = status error. `nestrixSpanProcessor` exported. |
| P2-04 | Pre-sampling route statistics; dashboard-path handling in the request hook | opus | P2-01 | done | Exact counts at sampleRate 0.1 on 3 adapters; reviewed: shadowing now GET/HEAD non-404 only, async callback guarded, absolute-form targets, wall-clock buckets, abort tests. |
| P2-05 | Dashboard access control and startup token | opus | P2-00 | done | Reviewed + security-reviewed (no bypass found); fixes: no cookie cap, Secure outside loopback in enabled mode, per-process salt on auth cookie, resolveUi never throws. |
| P2-06 | Mounting, asset serving, query API handlers, shadowing | opus | P2-02, P2-03, P2-04, P2-05 | done | 3 adapters, prefix/versioning/security headers/host CORS/testing. Reviewed; fixes: link logged after a slow start, case-insensitive path in the hook, bare denied 404, HEAD tests. 1,129 tests. |
| P2-07 | Security test file, one test per §4.7 rule | sonnet | P2-06 | done | 82 tests on 3 adapters; reviewed (13 injected breaks, all now caught); added exchange cross-site, guard order, read-only, strict not-registered check, no silent LAN skip in CI. |
| P2-08 | UI shell and request list | sonnet | P2-01, P2-02 | done | Shell, live list (poll, pause, load older, reset), nuqs filters from protocol specs; 42 e2e + 25 unit tests; 638 KB. No Testing Library (not in D-52): Vitest for logic, Playwright for rendering. |
| P2-09 | UI trace waterfall and span detail | sonnet | P2-08 | done | Virtualised treegrid (`@tanstack/react-virtual` 3.14.26), detail panel, keyboard; 5,000 spans keep ≤60 DOM rows; row markup `data-testid="span-row"` + `aria-level`. |
| P2-10 | UI error list and routes view | sonnet | P2-08 | done | Error list (live) and routes table + uPlot charts (15/60 min in URL), sampling note; UI total 760 KB; 89 e2e + 48 unit pass. |
| P2-11 | Example apps, Playwright end-to-end, CI job | sonnet | P2-06, P2-09, P2-10 | done | `e2e/` workspace (app entries import the examples' modules: the examples are test fixtures of `@nestrix-js/nestjs`, so depending on it would be a cycle); 16 Playwright tests mapped to the acceptance list; CI job (Node 26, Chromium) passes under act. |
| P2-12 | Store default limits and the with-dashboard benchmark | sonnet | P2-03, P2-04 | done | Defaults 5,000 traces / 32 MiB (typical trace ~4 KB heap); dashboard costs ~6 µs/request (store processor ~7 µs/span, stats 68 ns): −15% on a trivial route. Lazy exporter: −16 ms startup, −1.1 MB heap. `benchmarks/results/dashboard.md`. |
| P2-13 | Documentation | sonnet + lead | P2-11, P2-12 | done | README dashboard section + options, UI README, architecture §4.5–§8, nest-hooks `listen$`; doc-reviewer pass applied; install size re-measured (19.8 MB added). |
| P2-14 | Load the OTLP exporter graph only when export is on | sonnet | P2-00 | done | Dynamic import from the pipeline; pre-load batches wait in the single in-flight slot; child-process test: 0 exporter modules with export off, 55 on. RSS/startup not yet measured (quiet window). |
| P2-15 | Per-request allocation: profile and reduce | sonnet | P2-04 | done | Store 7.3 → 1.9 µs/span (eviction queue was 40% of CPU); dashboard cost on a trivial route −15% → −8.7%; −5% bytes/request. Reviewed (old vs new fuzzed: identical). Remaining allocation is Nest's interceptor machinery and the OTel SDK. |
| P2-16 | Flaky spike tests; `bench:memory` script | haiku | P2-00 | done | p0-s6 schedule and ticker tests wait for their condition; store-bytes takes the first in-band sample of up to 3 runs (bounds unchanged); `pnpm test` passed 3× in a row (1933 tests); `bench:memory` added. |
| P2-17 | Phase report | lead | all | done | `docs/phase-2-report.md`. Approved by the owner 2026-11-11. |

Statuses: `todo`, `doing`, `review`, `done`, `blocked` (say on what).

Order. Wave 1, in parallel: P2-01, P2-02, P2-05, P2-14, P2-16. Wave 2: P2-03 and P2-04 (Opus, disjoint files), P2-08. Wave 3: P2-06; P2-09 and P2-10 in parallel. Wave 4: P2-07, P2-11, P2-12, P2-15 (P2-12 and P2-15 never at the same time as each other or a full test run). Then P2-13, P2-17.

If P2-02 finds that a D-52 package cannot work (the CSP blocks it, nuqs fails under hash history, or the build exceeds 2 MB), work on the UI stops and the lead takes it to the owner: D-52 changes before features are built on it.

## Rules for every task

- The rules in `AGENTS.md`, the "Rules for every hook and subscriber" in architecture §4.2, and the phase 1 backlog's "Rules for every task" still apply.
- Dashboard handlers follow architecture §4.6 "Handlers" and "Assets" exactly: hijack on Fastify, write the raw response, strip `Access-Control-*`, catch everything and answer a 500 on the same raw response. Never `httpAdapter.reply`, `httpAdapter.end` or `reply.send()`.
- Access decisions read the raw socket and raw headers (`(req.raw ?? req)`), never `req.ip`, `req.hostname` or `getRequestHostname()`.
- `@nestrix-js/ui` has no runtime `dependencies`. Every UI package is a `devDependency` bundled at build time (D-52). Adding a package that D-52 does not list, or a runtime dependency to `@nestrix-js/nestjs`, is the owner's decision.
- `@nestrix-js/nestjs` imports **types only** from `@nestrix-js/protocol` (`import type`). That package is private and never published, so a runtime import would break installs. See P2-01 for how parameter specs stay in sync without a runtime import.
- Code copied into the repository (shadcn, tablecn, Dice UI) is MIT and keeps its notice; nothing from the owner's `nestjs-monorepo-template` except code the owner wrote (D-52).
- File ownership below keeps parallel agents apart. `packages/nestjs/src/index.ts` is edited only by the lead when merging.
- A change to a published package comes with a changeset (`@nestrix-js/nestjs` and `@nestrix-js/ui` share one version).
- A task is `done` when its checks have been run and their output read, `pnpm verify` passes, and, where the table says so, an independent `reviewer` has passed it and its findings are resolved.

## Public API

Settled here so parallel tasks agree. `architecture.md` §7 is updated to match in P2-13.

The new options are in `packages/nestjs/src/options.ts`: `ui?: false | 'auto' | NestrixUiOptions` (default `'auto'`) and `store?: NestrixStoreOptions`.

```ts
NestrixModule.forRoot({
  ui: {
    enabled: 'auto' | true | false, // default 'auto'
    path: '/_nestrix',              // default
    auth: { token } | { authorize(request) },
    startupToken: true,             // 'auto' only; false is the explicit opt-out (D-46)
  },
  store: { maxTraces, maxBytes },   // defaults from P2-12
});

// For a host that owns its SDK (architecture §4.5): add to its own spanProcessors.
nestrixSpanProcessor(): SpanProcessor // duck-typed; never throws, never rejects
```

**Mode resolution** (P2-05 implements, P2-06 wires). Evaluated once at `onModuleInit`; one log line states the outcome and, when off, why.

| Situation | Dashboard |
|---|---|
| `ui: false`, or `enabled: false` | Off. No routes, no store, no route statistics. |
| No HTTP adapter (`createMicroservice`, `createApplicationContext`) | Off, silently. |
| `@nestrix-js/ui` not installed | Off. Log line gives the install command. |
| `'auto'` and `NODE_ENV` set to anything but `development` | Off. Log line says `ui.enabled: true` plus `auth` serves it. |
| `'auto'`, `NODE_ENV` `development` or unset | On. Per request: loopback socket, loopback `Host`, no forwarding header, startup token cookie (unless `startupToken: false`), and `auth` if given. |
| `enabled: true` without `auth` | Off. Error logged; the app starts. |
| `enabled: true` with `auth` | On. Per request: `auth` only. No loopback or `NODE_ENV` check. |

Every mode that is on also rejects `Sec-Fetch-Site: cross-site` (D-30) and never emits CORS allow headers.

**Denied requests.** A denied request gets `404` with an empty body and only `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` (not the dashboard's CSP and other headers), so it reveals as little as a plain 404 can. The default path is well known, so this hides detail, not existence. One exception: in `'auto'` mode a request that passes the loopback checks but lacks the startup token cookie gets a `403` HTML page (or JSON error for the API) saying to open the link Nestrix logged at startup.

**Startup token** (D-46). 32 random bytes, base64url, generated once per process at `onModuleInit`. After `HttpAdapterHost.listen$` fires, one log line: `Nestrix dashboard: http://localhost:<port><path>/auth?token=<token>` (when `listen` is never called, the line gives the path and says the token link needs a listening server). `GET <path>/auth?token=` checks the token in constant time, sets the cookie and answers `303` to `<path>/`, so the token leaves the address bar. The same request still has to pass the loopback checks. Cookie: `HttpOnly; SameSite=Strict; Path=<path>`, no `Max-Age` (a session cookie; the token dies with the process anyway). **Cookies are not isolated by port**: two apps on `localhost:3000` and `localhost:4000` with the same path would overwrite each other's cookie, so the cookie name carries something per app (e.g. a short hash of the token itself, or of port and path). The built-in `auth: { token }` uses the same exchange endpoint and cookie, plus `Authorization: Bearer`.

**Routes** (all `GET`, under the configured path, outside the global prefix):

| Route | What |
|---|---|
| `<path>` and `<path>/` | `index.html`, templated per request with `<base href="<path>/">` and a JSON config block |
| `<path>/auth` | Token exchange (above) |
| `<path>/assets/<file>` | One exact route per built file, from the `@nestrix-js/ui` manifest |
| `<path>/api/v1/meta` | Service, sampling, store and statistics state, warnings |
| `<path>/api/v1/traces` | Trace list, newest first, cursor-paged |
| `<path>/api/v1/trace?id=<traceId>` | One trace, all stored spans |
| `<path>/api/v1/errors` | Error list, newest first, cursor-paged |
| `<path>/api/v1/routes` | Per-route statistics and time series |

Path parameters are not used: every parameter is in the query string, so routing behaves the same on all three adapters. The configured `path` is validated at resolution: it starts with `/`, has no trailing slash (one is removed), and contains only `A–Z a–z 0–9 . _ ~ / -`; otherwise the dashboard stays off and an error is logged.

**Headers on every dashboard response** (except denied 404s, above). `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'`; `X-Content-Type-Options: nosniff`; `X-Frame-Options: DENY`; `Referrer-Policy: no-referrer`; `X-Robots-Tag: noindex`; `Cache-Control: no-store` except hashed assets (`public, max-age=31536000, immutable`). No `Access-Control-*`. P2-02 confirms the CSP against the real build; if the build needs more, the lead decides and this line changes.

**Dashboard requests are not traced and not counted.** Requests whose raw path equals the configured path or starts with it plus `/` get no server span and no route statistics (the UI polls every two seconds and would otherwise fill the store with itself).

**Shadowing detection: passive** (architecture §4.6 left this to phase 2). A request under the dashboard path whose response closes without a Nestrix dashboard handler having run is logged once per process: with status 401, 403 or 429 as "answered by host middleware before the dashboard", otherwise as "shadowed by a host route (a catch-all, or `@nestjs/serve-static`'s fallback)". No startup self-request: it would run host middleware and the host's catch-all, create a trace at every boot, misreport a host auth gate as shadowing, and never run without `listen()`. The cost of passive detection is that it reports only once someone opens the dashboard, which is when it matters.

**Sampling in the UI.** `meta.sampling` is `{ owner: 'nestrix', rate }` or `{ owner: 'host', rate: null }`. The UI shows that lists are sampled when `rate < 1`, and that they may be when `rate` is `null`. Route statistics are counted before sampling in both cases (D-35), because the request hook is Nestrix's either way (D-33).

**Error definition** (settled after the P2-04 review, one rule everywhere): a span is an error when its status code is `error`. For server spans that means a 5xx response, or a handler exception that maps to 5xx (phase 1 sets error status only then, per the semantic conventions). A thrown 4xx (`NotFoundException`) keeps its exception event in the trace detail but is not an error in route statistics, the error list or the trace filter. The error list holds every stored span with error status (client spans, custom spans included).

**One store per process.** Created on first need, by the module or by `nestrixSpanProcessor()`, whichever comes first; the first creator's limits apply and a later different `store` option is ignored with one log line. Several apps in one process share it, as they share the provider (architecture §4.9).

## Tasks

### P2-01 Query API v1 types, parameter specs, fixtures

**Owns.** `packages/protocol/**`.

**Do.**
- Types for every route in "Public API": `MetaResponse`, `TraceListResponse` and `TraceSummary`, `TraceResponse` and `SpanRecord`, `ErrorListResponse` and `ErrorItem`, `RouteStatsResponse` and `RouteStats`, and `ApiError` (`{ error: { code: 'bad_request' | 'forbidden' | 'not_found' | 'internal', message: string } }`). `PROTOCOL_VERSION = 1`.
- Shapes. Times as `startTimeUnixMs: number` (fractional milliseconds) and `durationMs: number`. `SpanRecord`: `spanId`, `parentSpanId?`, `name`, `kind` (`'server' | 'client' | 'internal' | 'producer' | 'consumer'`), times, `attributes: Record<string, AttributeValue>`, `events: { name, timeUnixMs, attributes }[]`, `status: { code: 'unset' | 'ok' | 'error', message? }`, `links: { traceId, spanId }[]`, `scope?: string`. `TraceResponse` carries the resource attributes once. `TraceSummary`: `traceId`, `rootSpanId`, `name`, `method?`, `route?`, `statusCode?`, `error`, `startTimeUnixMs`, `durationMs`, `spanCount`, `cursor`. The local root is the earliest span with no parent inside the trace (a remote parent counts as none).
- Cursor paging: lists take `limit` (1–200, default 50) and either `before` (older page) or `after` (newer items, for polling). Cursors are opaque strings. Responses carry `head` (cursor of the newest item, for the next `after`), `older` (cursor for "load older", `null` at the end of the store) and `reset: true` when a cursor came from another process or was evicted.
- Filters: traces take `route`, `method`, `status` (`'ok' | 'error' | '4xx' | '5xx'`), `minDurationMs`, `search` (substring of span name or route, max 200 chars); errors take `route`; routes take `windowMinutes` (`15 | 60`, default 15). Since P5-03 every list and statistics route also takes `service` (max 256 chars; the embedded dashboard answers empty for a name other than its own) and `meta` has `mode`.
- Parameter specs as `as const` objects (`traceListParams`, `errorListParams`, `routeStatsParams`, `traceParams`), with an exported type for each (`type TraceListParamsSpec = typeof traceListParams`). The UI builds nuqs parsers from the values. `@nestrix-js/nestjs` cannot import the values (private package), so it declares its own copy typed against the spec type: `const spec: TraceListParamsSpec = { … }`. With literal types, any drift fails `tsc`. Write a two-line example of that in a comment.
- `fixtures/`: one realistic JSON response per route (a trace with server, client, internal spans, an exception event and a remote parent; a route list with series), typechecked against the types by a test, for UI development and tests before the server exists.

**Do not.** Add runtime dependencies or zod. Use path parameters.

**Done when.** `tsc` passes; a test imports each fixture and asserts it satisfies its type (via `satisfies` in a `.ts` fixture loader); a check that no `.d.ts` reachable from `packages/nestjs/dist/index.d.ts` references `@nestrix-js/protocol` is written as a test (it passes trivially now, and guards P2-03/P2-06); `pnpm verify` passes.

### P2-02 UI foundation: build, size budget, CSP, nuqs under hash history

**Owns.** `packages/ui/**`, root `package.json` devDependencies for Playwright if needed, `.github/workflows/ci.yml` (size step only).

**Do.**
- Vite 8, React 19, TypeScript, TanStack Router (hash history), TanStack Query, Tailwind 4, shadcn `base-nova` on `@base-ui/react`, lucide, `clsx` + `tailwind-merge`, `class-variance-authority`, `tw-animate-css`, `@fontsource-variable/geist-mono`, nuqs with its TanStack Router adapter. Versions from the registry; no devtools in the build (D-52, D-53). Report each version.
- A minimal app: two routes (`#/` and `#/traces/$traceId`), one shadcn button, one table from TanStack Table, a nuqs-bound filter, a uPlot chart, Geist Mono text. Enough to put every D-52 package in the bundle that phase 2 will use.
- Build into `dist/` with relative asset URLs (`base: './'`), hashed file names under `dist/assets/`, `index.html` with a `<base href>` placeholder and a `<script type="application/json" id="nestrix-config">` placeholder that the server fills. No inline script, no inline `<style>`. Keep `dist/index.js`/`index.d.ts` (the Node entry exporting `dashboardDirectory` and `manifestUrl`) and `manifest.json` (path, size, sha256, content type). Bundle the MIT notices of copied and bundled code into `dist/THIRD_PARTY_NOTICES.txt`.
- Size check: `packages/ui/scripts/check-size.mjs` reads `npm pack --dry-run --json`'s `unpackedSize` and fails above the budget; wired into `check:package`. Measure the first build. Budget per D-52: 1 MB if it fits; otherwise measured size plus 20%, at most 2 MB. Above 2 MB: stop and report (owner decision).
- CSP and `<base href>` check: a Playwright test serving `dist/` from a plain `node:http` server under `/some/deep/_nestrix/` with the exact headers in "Public API", filling `<base href>` and the config block as the server will. It fails on any CSP violation (`securitypolicyviolation` events and console errors), on any failed request, and if the app does not render. Run it in Chromium; Firefox if cheap.
- nuqs under hash history: in the same harness, set a filter, check the hash URL holds the search param, reload, check the filter is restored, navigate to a trace and back, check it survives. If nuqs cannot do this, report it with evidence; do not work around it with a different library (that is a D-52 change).

**Do not.** Build features. Add packages D-52 does not list (`cmdk` only if the budget allows, and say so).

**Done when.** The three D-52 items have a recorded answer with evidence: measured unpacked size and the budget it implies, the CSP run (no violations) under a non-root `<base href>`, and nuqs under hash history. `pnpm verify` passes; the size check fails when the budget is lowered below the measured size (show it). Report what had to change in the CSP, if anything.

### P2-03 In-memory store and `nestrixSpanProcessor()`

**Owns.** `packages/nestjs/src/store/**`; the processor's registration in `src/otel/pipeline.ts`; extracting the shared scrub step from `src/otel/redacting-exporter.ts` into a function both use.

**Do.**
- `nestrixSpanProcessor()`: duck-typed `SpanProcessor` across API/SDK copies (architecture §4.5). `onStart` does nothing; `onEnd` pushes the span onto a bounded pending queue (overflow dropped and counted) and schedules one drain; `forceFlush` drains and resolves; `shutdown` resolves. All four catch everything and never reject. No `instanceof`.
- The drain runs off the request path (a `setImmediate` scheduled once per batch, not per span): for each span, copy it into a `SpanRecord` (P2-01), apply Nestrix's scrub step and the user's `redact` hook (D-37, architecture §4.8; drop on `false` or throw, counted), and insert.
- Store: per-process singleton ("Public API"). Groups spans by trace id; a trace becomes listable when its local root ends; spans ending later are appended. Bounded by `maxTraces` and approximate bytes (estimate per record, not `JSON.stringify` per span on the hot path unless measured cheap); oldest trace evicted first. Monotonic sequence numbers per listed trace and per error item give cursors; the cursor carries a per-process epoch so a cursor from another process returns `reset`. Queries for the trace list (filters, `before`/`after`), one trace, the error list, and the stats needed by `meta` (counts, bytes, evicted, dropped, whether any span has arrived).
- When Nestrix owns the provider and the dashboard is on, the pipeline adds the processor. When the host owns the provider, nothing is added, and one log line tells the host to add `nestrixSpanProcessor()` to its `spanProcessors` (architecture §4.5).
- Default limits: provisional `maxTraces: 1000`, `maxBytes: 32 MiB`, until P2-12.

**Do not.** Touch `src/http/**`. Store anything when the dashboard is off. Add a dependency.

**Done when.** Unit tests: eviction by count and by bytes; late child spans; traces with a remote parent; cursor paging forwards and backwards with eviction in between; `reset` across epochs; redaction applied to a host instrumentation's span; a throwing `redact` drops the span and the store keeps working; an `onEnd` that receives a malformed span-like object does not throw. Integration test: the Nestrix-owned pipeline on Express fills the store; a host-owned SDK 3 provider with `nestrixSpanProcessor()` fills it. Reviewer pass.

### P2-04 Pre-sampling route statistics; dashboard-path handling in the request hook

**Owns.** `packages/nestjs/src/stats/**`, `src/http/server.ts`, `src/http/request-state.ts`.

**Do.**
- Statistics recorded at the raw response's `close`, for every request the hook sees, whether or not its span is recording (D-35). Key: `METHOD route-template`; no template means `METHOD (unmatched)`. Per key, per one-minute bucket, the last 60 minutes: count, error count ("Public API" definition), and a fixed log-spaced duration histogram (1 ms to 60 s, about 30 buckets) from which p50/p95/p99 are read. At most 500 keys; beyond that, `other`. Typed arrays allocated per key on first use; nothing allocated per request beyond what the request state already holds. Requests excluded by `ignore.routes` are not counted (they never get a request state); say so in the API's `meta`.
- Dashboard path: a request whose raw path is the dashboard path or under it gets no span and no statistics, but keeps a minimal request state with a "dashboard handler reached" flag that P2-06's handlers set, and at `close`, if the flag is unset, calls a shadowing callback with the status code (P2-06 logs it).
- Only when the dashboard is on: with it off, `server.ts` behaves exactly as in phase 1.
- A query function for P2-06: per-route totals and series for a window.

**Do not.** Change span behaviour for non-dashboard requests (the conformance suite must pass unchanged). Read the clock more than once per request at close.

**Done when.** Tests on all three adapters: at `sampleRate: 0.1`, the count per route equals the requests sent (400 requests over three routes, including a 404 and a thrown 500); dashboard-path requests produce no span and no count; the shadowing callback fires for a host catch-all on Express and not when the dashboard handler ran; percentiles from the histogram are within one bucket of the exact values on a known distribution; the 501st key goes to `other`; the conformance suite passes. Reviewer pass.

### P2-05 Dashboard access control and startup token

**Owns.** `packages/nestjs/src/dashboard/access.ts`, `src/dashboard/startup-token.ts`, the `ui` and `store` parts of `src/resolve-options.ts`.

**Do.**
- Resolve `ui` and `store` per "Public API": mode table, path validation, `auth` shape validation (a token shorter than 32 characters is an error, dashboard off), `startupToken` default. `NODE_ENV` read by the module factory as the other environment variables are.
- `checkAccess(rawRequest, resolved, tokenState): Allow | Deny404 | NeedToken403`, a pure function of the raw socket address, raw headers and the cookie header, per architecture §4.7: loopback forms `127.0.0.0/8`, `::1`, `::ffff:127.0.0.0/104`; `Host` present and loopback (`localhost`, `127.x.y.z`, `[::1]`, with or without port); none of `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`, `Via`; `Sec-Fetch-Site: cross-site` denied in every mode. Token comparison with `crypto.timingSafeEqual` on equal-length buffers (hash both sides first so length does not leak). `authorize` is awaited; a throw, rejection or non-`true` result denies; it is called only after the cheap checks pass.
- Startup token: generation, the cookie name rule ("Public API"), parsing the `Cookie` header without a dependency (several cookies, spaces, quoted values, duplicates: any matching value admits), the exchange handler's decision (set-cookie value and redirect target), and the log line text.
- Port `isLocalRequest()` from `spikes/p0-s5/src/dashboard.ts`; re-check it against the rule above rather than trusting it.

**Do not.** Register routes or write responses (P2-06). Trust `req.ip`, `req.hostname`, `getRequestHostname()`.

**Done when.** Unit tests for every row of the mode table, every loopback and non-loopback address form, each forwarding header alone, `Host` missing / foreign / loopback with port / IPv6, cookie parsing edge cases, token compare (right, wrong, wrong length, empty), `authorize` throwing, rejecting, returning `'yes'`. Reviewer pass and a `security-reviewer` pass.

### P2-06 Mounting, asset serving, query API handlers, shadowing

**Owns.** `packages/nestjs/src/dashboard/**` except P2-05's files; `src/core.ts` and `src/nestrix.module.ts` wiring; `@nestrix-js/ui` as an optional peer of `@nestrix-js/nestjs` (exact version, `peerDependenciesMeta.optional`, like `pg`).

**Do.**
- Load `@nestrix-js/ui` at `onModuleInit` without top-level `await` (rule 4): resolve it with `import.meta.resolve` or `createRequire`, read `manifest.json` and every listed file into memory once. Not installed: off with the log line.
- Register the routes in "Public API" with `httpAdapter.get` in `onModuleInit` (D-45). Every handler: mark the request state's "dashboard handler reached" flag (P2-04); hijack (`reply.hijack()` when present); take `res.raw ?? res`; run `checkAccess` (P2-05); remove every `Access-Control-*` header; set the headers in "Public API"; write status, headers and body to the raw response; catch everything and answer 500 through the same path. On Fastify never `reply.send()`.
- `index.html`: replace the placeholders with `<base href>` (HTML-escaped) and the config JSON (`apiBase`, `path`, protocol version; `<` escaped as `<`).
- API handlers: parse query parameters with a local spec copy typed against P2-01's spec types; reject unknown or malformed values with `400` and an `ApiError`; serialise store and stats results to the P2-01 types.
- Log the shadowing callback (P2-04) once per process with the wording in "Public API".
- With the dashboard on and the host owning the SDK, `meta.warnings` includes the `nestrixSpanProcessor()` hint until the first span arrives.

**Settled by earlier tasks and reviews** (P2-02, P2-04, P2-05):
- Placeholders in the built `index.html`: `<base href="__NESTRIX_BASE_HREF__">` and `"__NESTRIX_CONFIG__"` (with the quotes; replace the whole quoted token with the escaped JSON).
- Routes only for `index.html` and `assets/*` from the manifest; not for `index.js`, `.d.ts`, source maps or `THIRD_PARTY_NOTICES.txt`.
- The mode is resolved by `resolve-options.ts` (module factory) and is known when the `NestrixCore` constructor runs; pass the P2-04 hook config and P2-03's `dashboardStore` there (SDK 3 providers take processors only in their constructor). Routes are still registered in `onModuleInit` (D-45). With no HTTP adapter, detach the store.
- Race `checkAccess` against a 10 s timeout that resolves to deny, so an `authorize` that never settles cannot hold the socket.
- Never serialise `ui.auth` (it holds token digests) into `meta`, logs or errors.
- The exchange's `303` carries the full header set (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`).
- `auth: { token }` may still be exchanged through `<path>/auth?token=` (the only browser path without a form, which a read-only API should not have); its cookie is `Secure` outside loopback and salted per process. P2-13 documents that the link lands in proxy access logs and browser history, and recommends `Authorization: Bearer` for tools.
- Use the stats `onShadowed` callback with the wording in "Public API"; P2-04 reports only `GET`/`HEAD` with a status other than 404.

**Do not.** Use `httpAdapter.reply`/`end`, a static-file plugin, path parameters, or a global filter. Add state-changing endpoints.

**Done when.** Integration tests on Express, Fastify and platform-node, each with and without a global prefix and URI versioning, with `app.useSecurityHeaders()`, with `enableCors({ origin: true, credentials: true })` and Fastify's `hook: 'preSerialization'`, and under `@nestjs/testing`: index, an asset (byte-exact, right content type), every API route; no `Access-Control-Allow-*` on any response, success or error; the CSP header is Nestrix's; a handler fault answers 500 and the host's filter is not called; a catch-all on Express is logged as shadowing after one visit; `NODE_ENV=production` with `'auto'` registers nothing and the app starts. The P2-01 `.d.ts` check passes. Reviewer pass.

### P2-07 Security test file, one test per §4.7 rule

**Owns.** `packages/nestjs/test/dashboard-security.test.ts` (and a fixture next to it).

**Do.** One named test per rule of architecture §4.7 and "Public API", each on all three adapters, against real sockets (raw TCP where headers must be exact): auto mode off outside `development`; `@nestrix-js/ui` absent; non-loopback peer; foreign `Host`; missing `Host` (HTTP/1.0); each forwarding header; `Sec-Fetch-Site: cross-site` in each mode; startup token missing, wrong, right (exchange sets the cookie and redirects, then data loads); the same-host reverse proxy case (a local proxy process that rewrites `Host` and adds no forwarding header, as in `spikes/p0-s5`) denied without the cookie; `startupToken: false` admits it (documented limit); `enabled: true` without `auth` stays off and the app starts; token auth by header and by cookie; `authorize` receiving the raw request, and throwing; no CORS allow headers with permissive host CORS on success and error paths; preflight behaviour recorded as the documented limit; `X-Robots-Tag`, CSP and `nosniff` present; no inline script executes (the config block is `application/json`); a denied request reveals nothing (404, empty body).

**Done when.** Every rule has a test that fails if the rule is removed (show it for three rules by breaking `checkAccess` locally); `pnpm verify` passes. Reviewer pass.

### P2-08 UI shell and request list

**Owns.** `packages/ui/app/**` (shell, data layer, requests view), copied components under `packages/ui/app/components/` (the app lives in `app/`; `src/` holds only the Node entry).

**Do.** App shell: header with service name, connection state and the sampling notice from `meta`; navigation (Requests, Errors, Routes); light and dark from `prefers-color-scheme`. Data layer: TanStack Query, typed fetchers for P2-01 responses relative to the config's `apiBase`, polling every 2 s while the tab is visible, paused when hidden or by a "pause live" toggle. Requests view: the slim tablecn data table (D-52) with TanStack Table in manual filtering and sorting mode; columns time (relative, Dice UI `relative-time-card`), method, route, status, duration, spans, error; filters method, status, route (faceted from `/routes`), minimum duration, search, held in the URL by nuqs with parsers built from P2-01's specs; live head (new items prepended from `after=head`) and "load older" (`before=older`); `reset` clears and reloads; empty, loading (skeleton) and error states. Develop against P2-01's fixtures through a Vite dev middleware.

**Do not.** Add packages beyond D-52. Use `localStorage` for anything but the pause toggle.

**Done when.** Component tests (Vitest + Testing Library, or the Playwright harness from P2-02) for list rendering, filter round-trip through the URL, polling merge without duplicates, load older, `reset`; the size check passes; `pnpm verify` passes.

### P2-09 UI trace waterfall and span detail

**Owns.** `packages/ui/app/views/trace/**`.

**Do.** Built in-house (D-1). Rows in tree order (children by start time), indentation, collapse and expand, a duration bar positioned on the trace's time axis with a scale header, error rows marked, kind shown; spans whose parent is missing from the store shown at the root with a marker. TanStack Virtual for long traces (5,000 spans stay smooth). Selecting a row opens a detail panel: name, kind, timing, status, attributes (sorted, copyable), events with exception type, message and stack trace in Geist Mono, links. Trace header: route, status, duration, span count, trace id (copy). Evicted trace (`404`): a clear message and a link back.

**Done when.** Tests: tree order and depth from P2-01's fixture; collapse hides descendants; bar offsets and widths proportional to times; a 5,000-span generated trace renders only visible rows; `pnpm verify` passes.

### P2-10 UI error list and routes view

**Owns.** `packages/ui/app/views/errors/**`, `packages/ui/app/views/routes/**`.

**Do.** Errors: newest first, time, exception type, message (one line, full on hover/expand), route, link to the trace; live head and load older as in P2-08; route filter. Routes: table of routes with request count, error rate, p50/p95/p99, sorted by count; selecting a route shows uPlot charts for latency percentiles and for requests and errors per minute over 15 or 60 minutes (`windowMinutes` in the URL). A note that route statistics are complete while lists are sampled when `meta.sampling.rate < 1`.

**Done when.** Tests for rendering from fixtures, window switch through the URL, the sampling note; the size check passes; `pnpm verify` passes.

### P2-11 Example apps, Playwright end-to-end, CI job

**Owns.** `examples/**` (dashboard enabled), a new `e2e/` workspace (Playwright; make sure the root Vitest project list does not pick it up as a Vitest project with failing tests), the CI job.

**Do.** Enable the dashboard in `express-esm`, `fastify-esm`, `node-esm` and `express-cjs`. Playwright, Chromium: for each adapter, with and without a global prefix, with `app.useSecurityHeaders()` and with host CORS: follow the startup-token link from the app's log, send a few requests, open the request list, open a trace and check the waterfall rows (names and nesting), check the error list shows a thrown error and the routes view shows counts; fail on any CSP violation or console error. Plus: an app with `sampleRate: 0.1` shows route counts equal to requests sent and the sampling notice; an Express app with a catch-all logs the shadowing line; `NODE_ENV=production` without `auth` gives 404 and the app serves its own routes. CI: one job on Node 26 only (Actions minutes, decisions.md), Chromium only, browsers cached.

**Done when.** The suite passes locally and under `act`; the job is in `ci.yml`; `pnpm verify` passes.

### P2-12 Store default limits and the with-dashboard benchmark

**Owns.** `benchmarks/**` (with-dashboard configuration, results under `benchmarks/results/`), the default limits in `src/store/`.

**Do.** Measure bytes per stored trace (heap after forced GC) for three trace shapes (server span only; server plus 5 client spans; server plus 50 spans with attributes and an exception). Propose defaults so the store stays under about 32 MB with typical traces; the lead sets them. Add the "with dashboard" configuration to the existing benchmark (architecture §4.9) and run it **for 2–3 minutes**, never alongside another benchmark or a full test run: p50/p99, throughput and RSS against headless. Report the store processor's and the statistics' cost per request.

**Done when.** `benchmarks/results/dashboard.md` with the commands and numbers; defaults updated with the reason; `pnpm verify` passes.

### P2-13 Documentation

**Owns.** `packages/nestjs/README.md` (dashboard section), `packages/ui/README.md`, root `README.md`, `docs/architecture.md` §4.6, §4.7, §6, §7 (the lead writes the architecture changes), `docs/nest-hooks.md` if anything changed, changesets.

**Do.** The dashboard section: install, what `'auto'` does and its limit (same-host proxy, the startup token, the opt-out), production with `auth` (token, `authorize` and its raw request before guards), the path and the global prefix, a host that owns its SDK (`nestrixSpanProcessor()`), sampling and statistics, shadowing and what to do about it, the preflight limit, memory (store limits from P2-12). Typecheck the samples, as in phase 1.

**Done when.** Samples typecheck; a `doc-reviewer` pass on the README against the code; `pnpm verify` passes.

### P2-14 Load the OTLP exporter graph only when export is on

**Owns.** `packages/nestjs/src/otel/setup.ts`, `src/otel/pipeline.ts` (the exporter import only).

**Do.** The exporter (and its sdk-metrics graph, about 3 MB RSS and 110 files, phase 1 report §5) is imported only when export is on, with a dynamic `import()` from code that is already asynchronous or deferred, never top-level `await` (rule 4). Spans that end before the exporter has loaded are not lost (or the setup waits; say which and why). Measure RSS and startup with export off, before and after, with the existing startup benchmark (short run).

**Done when.** A test that with export off the exporter module is not in the module graph (e.g. a child process checking `process.moduleLoadList` or a loader hook in the test only); export-on tests unchanged; `pnpm check:tla` passes; numbers in the report; `pnpm verify` passes.

### P2-15 Per-request allocation: profile and reduce

**Added after P2-12:** the store costs about 7 µs per span (−15% throughput on a trivial route with the dashboard on, `benchmarks/results/dashboard.md`). Profile the store's per-span path (onEnd, drain: copy to `SpanRecord`, scrub/redact, byte estimate, insert) as part of this task and reduce what is avoidable.

**Owns.** Whatever the profile points at in `src/http/**` and `src/privacy.ts`, after P2-04 has merged.

**Do.** Phase 1 report §5: profile allocation per traced request (generator in header iteration, unexplained `WeakSet`/`Map` allocations, request state lifetime), reduce what is Nestrix's own, measure before and after with a short run. If a fix changes how a span's lifetime or the request state works, stop and report: the design goes to Opus.

**Done when.** Before and after numbers (bytes allocated per request, young-generation scavenges per 10,000 requests) in `benchmarks/results/`; conformance passes; `pnpm verify` passes.

### P2-16 Flaky spike tests; `bench:memory` script

**Owns.** `spikes/p0-s6/**` tests named in the phase 1 report, `benchmarks/package.json`.

**Do.** Make the two intermittently failing `spikes/p0-s6` timing tests robust under full-suite load without weakening what they assert (wait for a condition instead of a fixed delay; widen nothing that is the point of the test). Add a `bench:memory` script that runs the existing memory investigation harness.

**Done when.** `pnpm test` passes three times in a row with both tests included; `pnpm --filter benchmarks bench:memory` runs; `pnpm verify` passes.

### P2-17 Phase report

`docs/phase-2-report.md` in the shape of the phase 1 report: acceptance table with evidence, what was done, what changed from the plan, known limits, cost, what needs the owner. Then stop for the owner.

## Proposals for the owner

Not acted on; raised at the gate unless the owner answers earlier.

- **Decided (D-54, owner, 2026-11-11):** `@nestrix-js/ui` as an optional peer of `@nestrix-js/nestjs` (P2-06), pinned to the same version. pnpm's isolated layout means `@nestrix-js/nestjs` cannot resolve `@nestrix-js/ui` unless it is declared; an optional peer is never installed by itself, like `pg`. The lead treats this as part of D-3 (two packages, one version), not a new runtime dependency. Say if you see it otherwise.
- **Reject `Sec-Fetch-Site: same-site` too.** Pages on another port of `localhost` are same-site, not cross-site, so D-30's rule lets them send requests carrying the `SameSite=Strict` cookie. They cannot read the responses (no CORS), and the API is read-only, so this is defence in depth only. The dashboard's own requests are `same-origin`; allowing only `same-origin`, `none` and an absent header would cost nothing. It changes D-30, so it is the owner's call.
