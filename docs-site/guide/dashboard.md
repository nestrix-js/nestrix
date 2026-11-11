# Dashboard

With `@nestrix/ui` installed, `NestrixModule` serves a read-only dashboard from inside your app, at `/_nestrix` by default. It works on Express, Fastify and `@nestjs/platform-node`. It shows only what this process has seen since it started: nothing is written to disk and nothing is sent anywhere.

`@nestrix/ui` is an optional peer dependency. Without it the dashboard is off and Nestrix logs one line with the install command; the app starts normally. An app with no HTTP adapter (`createMicroservice`, `createApplicationContext`) has no dashboard.

How it is opened and secured is on the [Security model](/guide/security) page. The same UI is served by the [standalone server](/guide/standalone-server), backed by PostgreSQL instead of memory.

## Views

The dashboard polls for new data every two seconds.

**Requests.** Recent traces, newest first, with filters for status, error, route, release, user and trace type (HTTP, jobs, scheduled). Release and user columns appear when any stored trace has them (see `serviceVersion` and `user` in the [reference](/reference/configuration)).

**Trace waterfall.** One request's spans as a waterfall: server span, method spans, database and cache spans, outgoing HTTP calls and exception events.

**Errors.** Every stored span with error status, client spans and your own spans included. A span is an error when its status code is `error`: for a server span, a 5xx response or a handler exception that maps to 5xx. A thrown `NotFoundException` (404) keeps its exception event in the trace detail but counts as no error.

**Routes.** Per-route request counts, error rates and latency percentiles (p50, p95 and p99), for the last 60 minutes in one-minute buckets. A route is keyed by `METHOD route-template`, for example `GET /users/:id`; a request no route matched is `METHOD (unmatched)`. At most 500 keys are tracked; further routes are counted together under `* (other)`. Percentiles come from 30 log-spaced buckets from 1 ms to 60 s, so they are accurate to a bucket, not exact.

**Classes.** One row per class, expandable to its methods: calls, errors, average time, total time and own time (time not spent in the method's children), over the last 15 or 60 minutes. The view is empty until [method spans](/guide/levels#level-2-method-spans) are on, and says so.

**Map.** The app in the centre and what it called: databases (by system, host and database name), Redis as a cache, HTTP hosts and message queues, each with calls, errors, p50 and p95. At most 200 targets are shown; the rest are folded into one `other` node.

## Sampling notes

- **Routes and classes count every request**, whatever the sample rate and whether Nestrix or your own SDK does the sampling. Calls, errors and total time for classes are counted before sampling too.
- **The request list, error list, map and own time come from stored spans, so they are sampled.** At `sampleRate: 0.1` the Routes view shows every request and the list shows about one in ten. The dashboard says so when `sampleRate` is below 1, and says they may be when your SDK owns the sampler.
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
