# Phase 13 backlog: span limits per trace

Owner, 2026-11-12 (D-78): one BullMQ job can put thousands, even millions, of spans into one trace. Cap a trace's spans in the app and in the standalone server, count what is not recorded, and say so in the trace view. Ships in 0.2.0 together with phase 12 and the own-time query fix. Delivery mode (AGENTS.md). Design sources: our own needs and the public documentation of other tools (D-78 lists them); nothing from `@nestjs/observe` (rule 8).

Wire contract: `TraceResponse.droppedSpans` and `DroppedSpans` in `packages/protocol/src/types.ts`; span attributes `nestrix.trace.spans_dropped` (int) and `nestrix.trace.spans_dropped.<kind>` (int, kinds as `OverviewTimeShare.key`).

## Status

| ID | Task | Tier | Depends | Status |
|---|---|---|---|---|
| P13-00 | D-78, protocol, this backlog | lead | — | done |
| P13-01 | SDK: `maxSpansPerTrace` and dropped-span counting | opus | P13-00 | todo |
| P13-02 | Server: per-trace cap at ingest, dropped count stored, `droppedSpans` in `trace`; embedded store reads the attributes | sonnet | P13-00 | done |
| P13-03 | UI: "omitted N spans" in the trace view | sonnet | P13-00 | todo |
| P13-04 | Review, docs, changeset | lead + reviewer | P13-01..03 | todo |

## Settled design

### P13-01 SDK (runs in the host app: rule 1 applies in full)

- **Option.** `maxSpansPerTrace?: number | false`, default `10000`, minimum 100. Validated in `resolve-options.ts`; documented in the README option table and the docs site's configuration reference (the options check fails otherwise).
- **What it counts.** Spans per trace id in this process. When Nestrix owns the trace provider, enforce it for every span (Nestrix's own and other instrumentations', e.g. bullmq-otel, Prisma) with a sampler wrapped around the existing `ParentBasedSampler` in `otel/setup.ts`: past the limit, return a non-recording decision. When the host owns the SDK, enforce it only for spans Nestrix creates (`src/span.ts` and the instrumentation helpers), and document that the host's sampler decides the rest. Instrumentation code imports `@opentelemetry/api` only (rule 5); the sampler lives in the setup code.
- **Children of a dropped span.** A non-recording span must not make the rest of the trace look broken: later spans whose parent was dropped are dropped too (count them), and spans whose parent is recorded keep being recorded until the limit. Context propagation (traceparent to other services) keeps the trace id so downstream services still join the trace; decide and document the sampled flag sent downstream after the limit (prefer keeping it sampled so other services' spans still arrive, since each service has its own limit).
- **Counting and reporting.** Count dropped spans by kind (`db`, `http-out`, `redis`, `messaging`, `app`, `other`, classified from the span's name/attributes/kind at start as far as known). When the trace's local root span in this process ends (the request's server span, or the job's consumer/processor span), set `nestrix.trace.spans_dropped` and `nestrix.trace.spans_dropped.<kind>` on it if anything was dropped. If the SDK cannot set attributes at that point, find the supported hook (e.g. a span processor `onEnding`) or set them just before the instrumentation ends the root span; explain the choice.
- **Statistics stay exact.** Route statistics, class statistics and metrics are counted before sampling today (D-61); make sure dropped spans still count in class statistics (call counts and total time) the same way unsampled ones do.
- **Memory.** Per-trace counters in a bounded map (e.g. at most 10,000 live traces, entries removed when the local root ends or after 1 hour idle), so a leak is impossible.
- **Tests.** A trace with 25,000 child spans and limit 10,000: exactly 10,000 recorded (root included), 15,000 counted with kinds, the attributes on the root, class statistics still count all calls. Limit off (`false`) records everything. Host-owned SDK: only Nestrix spans limited. A BullMQ-style trace where the job's processor span is the local root. Two concurrent traces counted separately. Map stays bounded. Every hook catches everything (fault injection).

### P13-02 Server and embedded store

- **Server cap.** `NESTRIX_MAX_SPANS_PER_TRACE` (default 50,000; 1,000 to 10,000,000), documented in apps/server/README.md. At ingest, spans of a trace past the cap are not stored; count them per trace (a column or table, e.g. `trace_dropped(trace_id, dropped)` or a `dropped_spans` column on `traces`, updated in the same transaction). Counting must be cheap per batch (one count query per trace id in the batch, or a per-trace counter row), not a scan per span. Partial success answers stay correct (rejected spans reported as OTLP partial success with a message).
- **`trace` response.** Fill `droppedSpans` from the root's `nestrix.trace.spans_dropped*` attributes (sum over the trace's spans, since each service reports its own) plus the server's count. Absent when both are 0.
- **Embedded store.** The in-memory store already caps spans per trace? Check; if it has a cap, count what it drops; fill `droppedSpans` the same way from the attributes.
- **Tests.** Ingest 60,000 spans of one trace with cap 50,000: 50,000 stored, `droppedSpans.byServer` = 10,000; attributes from the app summed into `total` and `byKind`; the cap does not affect other traces; partial-success message.

- **As built (P13-02).**
  - Config: `maxSpansPerTrace` in `ServerConfig`, passed to the writer by `app.module.ts`.
  - Counting design: no new counter table. `traces.span_count` already counts the spans stored per trace, so inside the transaction, under the existing traces advisory lock (taken before the span insert instead of after, so every writer orders lock then insert), one `SELECT trace_id, max(span_count) FROM traces WHERE trace_id = ANY(...)` gives what is stored. A trace over the cap keeps `cap - stored` spans (earliest start first); the rest are not inserted. Exempt from the cap (always stored, not counted against other spans, but counted in `span_count`): spans with no parent, and spans carrying any `nestrix.trace.spans_dropped*` attribute (a local root in another service has a remote parent but carries the app's counts). A local root ends last, so it arrives after the trace is at the cap (`isCapExempt` in `writer.ts`). Cost per transaction: that one indexed SELECT, plus one `UPDATE traces SET dropped_spans = dropped_spans + n` only when something was dropped. No per-span work beyond a Map grouping.
  - Storage: migration `0010_traces_dropped_spans.sql` (`traces.dropped_spans bigint NOT NULL DEFAULT 0`), `schema.ts`, migrations test list.
  - Reporting: `IngestSink.write` may resolve with `{ droppedSpans }` (per batch, also in a group commit); the receiver adds it to `rejectedSpans` and appends a message to `partial_success.error_message`.
  - `trace`: `query/dropped-spans.ts` (`droppedSpansOf`) sums `nestrix.trace.spans_dropped` and `.<kind>` over the trace's stored spans and adds `traces.dropped_spans`. The embedded store has no per-trace span cap (it evicts whole traces), so it reports only the attributes (`byServer` 0), with a copy of the helper in `packages/nestjs/src/store/dropped-spans.ts` and the type added to the store's protocol mirror.
  - Known limits: a client with an ingest key can bypass the cap by sending spans with no parent or with a `nestrix.trace.spans_dropped` attribute (the key is trusted; the cap protects against runaway traces, not hostile ones). A retried export of already stored spans counts as dropped once the trace is at the cap.

### P13-03 UI

- Trace view: when `droppedSpans` is present, a banner above the waterfall: "This trace has N more spans that were counted but not recorded (limit: … in the app, … in the server)", with the per-kind counts, and a link to the docs section on `maxSpansPerTrace`. Under the root span row, an "(omitted N spans)" row in the waterfall.
- Trace list: an indicator on rows whose trace was capped if the list API already carries it; otherwise skip (do not change other API shapes).
- Tests: unit and Playwright against the mock API.
