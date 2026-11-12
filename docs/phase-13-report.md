# Phase 13 report: span limits per trace

Date: 2026-11-12. Written by the lead under delivery mode (`docs/backlog/phase-13.md`). Shipped in `0.2.0` with phase 12.

## 1. Summary

A trace has a bounded number of spans (D-78). In the app, `maxSpansPerTrace` (default `10000`, at least `100`, `false` turns it off) stops recording spans past the limit and counts them by kind (`db`, `http-out`, `redis`, `messaging`, `app`, `other`); the totals go on the trace's local root span as `nestrix.trace.spans_dropped` and `nestrix.trace.spans_dropped.<kind>`. Route and class statistics are counted before sampling and stay exact. In the standalone server, `NESTRIX_MAX_SPANS_PER_TRACE` (default 50,000; 1,000 to 10,000,000) stops storing spans past the cap, counts them per trace and answers the export with OTLP partial success. Both backends return `droppedSpans` in the `trace` answer, and the trace view shows a banner (how many spans were counted but not recorded, the app and server split, per-kind counts, a docs link) and an "(omitted N spans)" row under the root. The reason was a real BullMQ job that put thousands of spans in one trace and can put millions.

## 2. Acceptance

| Check | Result | Evidence |
|---|---|---|
| 25,000 spans in one trace, limit 10,000: exactly 10,000 recorded (root included), 15,000 counted by kind, attributes on the root, class statistics count every call | **Met** | `packages/nestjs/test/span-limit-owned.test.ts` (Nestrix owns the provider, OTLP receiver) and `span-limit-unit.test.ts`. The backlog said "25,000 children"; that is 25,001 spans and 15,001 dropped, so the test uses 25,000 spans. |
| `false` records everything; a host-owned SDK limits only Nestrix's spans; a BullMQ-style root; two concurrent traces; bounded map; every hook catches everything | **Met** | `span-limit-unit.test.ts`, `span-limit-owned.test.ts`, `span-limit-host.test.ts`, `resolve-options.test.ts` (fault injection throughout). |
| Server: over the cap only the cap is stored, the count is kept, partial success says so, other traces are unaffected, app counts are summed into `total` and `byKind` | **Met** | Server ingest and `trace` tests. The 60,000-span run is opt-in (`NESTRIX_LONG_TESTS=1`); small-cap tests cover the logic by default. |
| Trace view banner and row, in dark and light | **Met** | `e2e/omitted-spans.pw.ts` and `app/lib/trace-omitted.test.ts`. |
| Whole workspace | **Met** | `pnpm verify`: 3,737 tests; UI Chromium: 179; app-level end-to-end: 18. |

## 3. What was done

| Task | Result |
|---|---|
| P13-00 | D-78, `DroppedSpans` in the protocol, backlog. |
| P13-01 | `src/trace-limit.ts` (counter, host-mode helpers), `src/otel/span-limit.ts` (a limiting sampler around `ParentBasedSampler`, and a processor whose `onEnding` writes the counts), wiring in `otel/setup.ts`; every Nestrix span site starts through `startNestrixSpan` and ends through `endNestrixSpan`. |
| P13-02 | The server cap in the writer (`traces.span_count` under the existing advisory lock, no new counter table), migration `0010_traces_dropped_spans.sql`, partial success, `droppedSpansOf`; the embedded store reads the attributes (it evicts whole traces, so it has no span cap of its own). |
| P13-03 | The banner and the omitted row; the docs link goes to the README's "Large traces" section. |
| P13-04 | Opus review of P13-01, fixes, docs, changeset `span-limits-per-trace`. |

## 4. Reviews and their findings

The Opus review of P13-01 (it runs in the host process, so rule 1 applies in full) found three problems, fixed in a fix round, and one gap that is documented:

1. **Live traces evicted by leftovers.** With the counter map full, `sweep` could evict an entry whose trace was still running. Repro (limit 100, a job and 300 children, 20,010 leftover entries): 200 recorded and 50 dropped before, 100 and 201 after. Entries with an open local root are now kept.
2. **A dropped `withSpan` was not the active span.** `getActiveSpan()` inside it returned the recording parent. The non-recording stand-in is now made active.
3. **Host-owned SDK: siblings were unlimited.** A host root plus 250 sequential `withSpan` recorded 250; it now records 100.
4. **Documented gap, not fixed:** with a host-owned SDK and strictly sequential siblings, no Nestrix span is open when the limit is exceeded, so the drops are enforced but the number is not written to a span.

On the server, spans with no parent and spans carrying `nestrix.trace.spans_dropped*` are exempt from the cap, because a local root ends last and carries the app's counts.

## 5. Decisions

D-78 (the owner's). Judgement calls, recorded in `docs/architecture.md` §4.5 "Span limit per trace":

- **The downstream sampled flag after the limit is `-00`**, not the preferred `-01`. An SDK 3 sampler cannot return a non-recording span that stays sampled; the alternatives (record and filter, or rewrite `traceparent`) cost a `SpanImpl` per dropped span or misreport. A service that follows its parent's decision records nothing for a left-out span; each service applies its own limit.
- The `onEnding` hook is experimental in sdk-trace 3.1.1: a test pins it and a fallback is logged.
- Host-owned SDK: Nestrix's own spans only; a left-out span is replaced by its parent's context.

## 6. Deferred and known limits

- Cost far below the limit was measured: 77 to 92 ns per span on a bare provider (6.5 to 8%), the counter alone 8 to 10 ns (`test/manual/span-limit-bench.mjs`). Cost near and past the limit, and server ingest with the cap on, are not benchmarked (D-72).
- A client with an ingest key can bypass the server cap with spans that have no parent or that carry a drop-count attribute. The key is trusted; the cap is against runaway traces, not hostile ones.
- A retried export of spans already stored counts as dropped once the trace is at the cap.
- The trace list has no "capped" indicator: `TraceSummary` does not carry the count and API shapes were left alone.
- The banner does not print the configured limits, because the API carries counts, not limits.
- The opt-in "one trace per batch for long jobs, linked to the request that started them" (D-78) is not built.
