# Dashboard

With `@nestrix-js/ui` installed, `NestrixModule` serves a dashboard from inside your app, at `/_nestrix` by default. Apart from starting a [profiler](#profiler) capture it is read-only. It works on Express, Fastify and `@nestjs/platform-node`. It shows only what this process has seen since it started: nothing is written to disk and nothing is sent anywhere.

`@nestrix-js/ui` is an optional peer dependency. Without it the dashboard is off and Nestrix logs one line with the install command; the app starts normally. An app with no HTTP adapter (`createMicroservice`, `createApplicationContext`) has no dashboard.

How it is opened and secured is on the [Security model](/guide/security) page. The same UI is served by the [standalone server](/guide/standalone-server), backed by PostgreSQL instead of memory.

## Views

The dashboard polls for new data every two seconds. It opens on the Overview (`/`); the tabs, in order:

**Overview.** The home page says what is better and what needs attention, so you do not have to read tables first. Switch between the last 15 and the last 60 minutes; everything is compared with the window before it. Each card says whether its numbers are counted before sampling or built from stored, sampled traces.

- **Health.** A score from 0 to 100 with a level (`healthy` from 90, `degraded` from 70, else `critical`) and one sentence, for example "2 things need attention: POST /orders p95 412 ms → 680 ms, and PaymentGatewayError is new (214 events)." The score starts at 100 and loses points for each high (12) or medium (6) item in Needs attention, for the error rate (up to 30) and for a low Apdex (up to 40).
- **Needs attention** and **Getting better.** Up to six items each, ranked by impact (requests or events affected times the size of the change): a route whose p95 or error rate moved, a new or spiking error group (or one that cleared), a dependency that got slower or started failing, and on the standalone server an SLO that burns its budget. A route needs at least 20 requests in each window to be compared. Each item has a severity chip with words and an arrow, not colour alone, a sparkline and a link to the right page.
- **KPI tiles.** Throughput per minute, error rate, p95, Apdex and the slowest dependency's p95, each with its change and a sparkline. Throughput, error rate, p95 and Apdex are counted for every request, before sampling.
- **Latency percentiles** (p50, p95, p99, the previous p95 in grey, release markers), **throughput with errors** and the **Apdex split** (satisfied, tolerating, frustrated, for a threshold T shown on the card) are also before sampling. Apdex from the stored histograms is approximate: a request counts as satisfied when its bucket's upper edge is within T.
- **Donuts.** Responses by status and where request time goes (database, outgoing HTTP, Redis, messaging, your code, other) come from sampled traces, with the change in share against the previous window.
- **Top routes** by impact, and, on the embedded dashboard, a runtime card; on the standalone server, the SLO budget rings.

Until a full previous window has been kept, changes show "—" and the lists say so. The thresholds for each rule are listed in [`docs/backlog/phase-11.md`](https://github.com/nestrix-js/nestrix/blob/main/docs/backlog/phase-11.md).

**Requests** (`/requests`; a link to `/` that carries request-list filters is redirected here). Recent traces, newest first, with filters for status, error, route, release, user, trace type (HTTP, jobs, scheduled) and text. A request timeline chart sits above the list (drag across it to narrow the time range), each row has a duration bar, and a filter set can be saved by name in your browser. Release and user columns appear when any stored trace has them (see `serviceVersion` and `user` in the [reference](/reference/configuration)).

**Trace waterfall.** One request's spans as a waterfall: server span, method spans, database and cache spans, outgoing HTTP calls and exception events. Above it, a summary of where the time went by span kind and by class, and a critical-path toggle that highlights the spans on the critical path. The [log lines](#logs-next-to-the-trace) written during the request are listed beside it.

**Errors.** Opens **Grouped**: errors grouped by type, message and route, each with a count, first and last seen and a sparkline; **All** switches to the flat list. Both come from every stored span with error status, client spans and your own spans included. A span is an error when its status code is `error`: for a server span, a 5xx response or a handler exception that maps to 5xx. A thrown `NotFoundException` (404) keeps its exception event in the trace detail but counts as no error.

**Routes.** Per-route request counts, error rates and latency percentiles (p50, p95 and p99) over the last 15 or 60 minutes, kept in one-minute buckets. Selecting a route shows its **latency histogram**; a click on a bar opens the request list narrowed to that latency range. The **Compare** tab sets the last window against the one before it, or one release against another, with the biggest regressions first. A route is keyed by `METHOD route-template`, for example `GET /users/:id`; a request no route matched is `METHOD (unmatched)`. At most 500 keys are tracked; further routes are counted together under `* (other)`. Percentiles come from 30 log-spaced buckets from 1 ms to 60 s, so they are accurate to a bucket, not exact.

**Classes.** One row per class, expandable to its methods: calls, errors, average time, total time and own time (time not spent in the method's children), over the last 15 or 60 minutes. The view explains itself when [method spans](/guide/levels#level-2-method-spans) are off, and says "no data in this range" when they are on but the chosen window holds no method call.

**Map.** The app in the centre and what it called: databases (by system, host and database name), Redis as a cache, HTTP hosts and message queues, each with calls, errors, p50 and p95. At most 200 targets are shown; the rest are folded into one `other` node.

**Queries.** The slowest and the most frequent database statements across the stored traces: the sanitised statement text (never bind values), calls, total, average and maximum time, errors, and in how many traces a statement ran three or more times (a likely N+1), with links to example traces. Cache commands (Redis and the like) are listed too.

**Dependencies.** One row per host, database or Redis the app called, with calls, p95, errors and a trend line, and links to example traces.

**Runtime.** Event loop delay (p50, p99, max), heap used and total, RSS and CPU over the last hour, sampled every 10 seconds by a small timer that runs only while the dashboard is on. It needs no metrics setup. The standalone server has no such tab: it does not see your processes.

**Profiler.** An on-demand [CPU profile](#profiler), when the dashboard is authenticated. On the standalone server the same tab profiles any instance that opted in: see [remote CPU profiling](/guide/standalone-server#remote-cpu-profiling).

The [standalone server](/guide/standalone-server) adds **SLOs** (error budgets and burn rates) and **Settings** (read-only API tokens). The Runtime tab belongs to the embedded dashboard only.

## Logs next to the trace

With the dashboard on, a [`NestrixLogger`](/guide/logs-and-metrics) line written while a recording span is active is also kept in the store with its trace, and the trace view lists it beside the waterfall (click a line to select its span). It needs no extra package. What is kept: time, level, logger context and the message after the logger's own `redact` option, cut to 8,192 characters, with no stack traces; at most 200 lines per trace, counted in `store.maxBytes` and evicted with the trace. Lines outside a span, or under a span that is not sampled, are not kept, and there is no search across lines: the dashboard is not a log viewer. `ui: { logs: false }` keeps none (the logger still prints and the trace ids stay on your lines). The standalone server does the same with records sent to its `/v1/logs`. Log messages are free text, so do not log secrets.

## Profiler

The **Profiler** tab takes an on-demand CPU profile of the running process. Pick a duration (10 seconds to 2 minutes in the page; the API accepts 1 to 120 seconds, default 30) and start; when the capture ends the dashboard shows a flame graph, the top functions by self time and a `.cpuprofile` download for Chrome DevTools or speedscope. Nothing runs between captures, and nothing is loaded before the first one. One capture runs at a time per process (a second start gets `409`, and one within 10 seconds of the previous capture's end gets `429`); the last three are kept in memory until the app restarts, and a running capture is discarded when the app closes.

It is offered only where the dashboard is authenticated: `ui: { enabled: true, auth }`, or `'auto'` with the startup token or `auth`. `ui.profiler: false` removes it and its routes. Starting a capture needs HTTPS or localhost: browsers send the `Sec-Fetch-Site` header the start requires only to those origins, so over plain HTTP to another host the start is refused with `403` and the dashboard says why. How a start is protected is on the [Security model](/guide/security#starting-a-cpu-capture) page.

| | |
|---|---|
| Start pause | Starting a capture pauses the app while V8 records its compiled code: about 10 ms per MB of code, 40 to 50 ms in a small Nest app, a few hundred milliseconds in a large one. The dashboard shows the last measured pause before you start. Stopping takes a few milliseconds. |
| Cost while capturing | No throughput difference our benchmark could resolve (under about 5% on a trivial route). |
| Size | About 0.3 MB for 30 seconds and 1 MB for 2 minutes, more with many distinct call stacks. |
| Coverage | JavaScript on the main thread only; worker threads are not included. Lines are those of the running JavaScript: source maps are not applied. |
| Inlining | A function V8 inlined can appear under its caller instead of on its own, more often after the first capture in a process. |

## Sampling notes

- **Routes and classes count every request**, whatever the sample rate and whether Nestrix or your own SDK does the sampling. Calls, errors and total time for classes are counted before sampling too. The runtime view is process facts, not spans.
- **The request list, error list and groups, histogram, release comparison, queries, dependencies, map, trace summaries and own time come from stored spans, so they are sampled.** At `sampleRate: 0.1` the Routes statistics show every request and the list shows about one in ten. The dashboard says so when `sampleRate` is below 1, and says they may be when your SDK owns the sampler.
- Requests excluded by `ignore.paths` and requests to the dashboard itself are not counted or traced.

## Memory

The store keeps recent traces in memory, bounded by `store.maxTraces` (default 5,000) and `store.maxBytes` (default 32 MiB). The oldest trace is evicted first when either is reached. While the dashboard is off, nothing is stored. A typical request (a server span plus five client spans) holds about 4 KB of heap, so a full store of typical traces is about 20 MiB.

## What it shows

The dashboard shows stored spans, and the [privacy defaults](/faq#privacy) apply to them. Nestrix's own redaction and your `redact` hook run on every span before it is stored, including spans from other instrumentations. Free text is not cleaned by key: exception messages, stack traces and status messages are shown as they are. Use `redact` for those, and look at what the dashboard shows in development before you enable it elsewhere.

## A host that owns its SDK

If your app registers its own OpenTelemetry provider before Nestrix starts, add `nestrixSpanProcessor()` to its `spanProcessors` so spans reach the store:

```ts
trace.setGlobalTracerProvider(
  new TracerProvider({
    spanProcessors: [
      new BatchSpanProcessor({ exporter: new OTLPTraceExporter() }),
      nestrixSpanProcessor(),
    ],
  }),
);
```

If it is missing, Nestrix logs one line at startup and the dashboard shows the same warning. Route statistics do not need it.

## When something else answers first

A host route can answer a request under the dashboard path before Nestrix's route sees it: a catch-all route on Express, or `@nestjs/serve-static`'s fallback. Nestrix logs one line the first time it sees this. Exclude the dashboard path from that route, or set `ui.path` to another path.
