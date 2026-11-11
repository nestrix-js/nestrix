# Per-request allocation and the store's per-span cost (P2-15)

darwin-arm64, Node v26.13.0, 2026-11-11. One machine, nothing else running; no test suite or second benchmark at the same time. Raw results next to this file: `allocation-before.json|md`, `allocation-after.json|md`, `micro-before.json|md`, `micro-after.json|md` (also copied to `dashboard-micro.json|md`), `dashboard-after.json|md`.

## Method

- **Bytes per request and scavenges per 10,000 requests** (`src/allocation.mjs`, new). One fresh app process per run (`app.mjs`, same Express app as the other benchmarks), `--expose-gc`, 2 s warmup, then 8 s of closed-loop load (autocannon, 64 connections, `/hello` and `/users/42` alternating), 3 runs per configuration, medians. Inside the app process: bytes are the delta of `v8.getHeapStatistics().total_allocated_bytes` across the window divided by the completed requests (so they include Node's http, Express, Nest and the two IPC round trips that bracket the window; the runs agree within 0.1% for the instrumented configs); scavenges are the count of `perf_hooks` `gc` entries of kind minor (`app.mjs` counts them only when `BENCH_GC_COUNT=1`, so no other benchmark changes).
- **Where the bytes come from**: V8's sampling heap profiler through `app.mjs`'s existing `allocprof-start` / `allocprof-stop` messages, with `includeObjectsCollectedByMinorGC` and `...MajorGC` set so it shows everything allocated, not only what survives. Sampling interval 4,096 bytes, 4 s under load. Self size per function, then per-subtree and per-caller sums (scripts were throwaway, not kept). Sampling attributes inlined callees to their caller, so figures per function are approximate (about plus or minus 20%).
- **Store cost per span** (`src/dashboard-micro.mjs`, unchanged): one process, no HTTP, an SDK 3 span with and without the store processor, difference of medians of 3 loops of 500,000. CPU time spent by the store's code per span, found with `node --cpu-prof` on the same script.
- **Throughput**: `src/throughput.mjs --configs=headless,dashboard --duration=5 --runs=2`, one pass of the P2-12 command (the P2-12 figures are two passes of 2 runs; its two passes agreed within 1%).

## Results

### Allocation per request

| config | B/request before | B/request after | scavenges / 10k req before | after | req/s before | after |
| --- | --- | --- | --- | --- | --- | --- |
| baseline (uninstrumented) | 14,442 | 14,584 | 9.84 | 9.89 | 43,177 | 42,582 |
| interceptor (uninstrumented plus a no-op global interceptor) | not run | 31,208 | | 19.83 | | 35,724 |
| headless (`ui: false`) | 44,191 | **42,057** | 14.30 | 13.92 | 27,455 | 27,857 |
| dashboard | 48,367 | **45,815** | 15.54 | 14.71 | 23,009 | 24,935 |

(Baseline moved by under 1%, which is the run-to-run spread of this method. The `interceptor` row was measured after only, because Nestrix's code does not take part in it.)

- Headless: **-2,134 B per request (-4.8%)**. Dashboard: **-2,552 B per request (-5.3%)**.
- Scavenges per 10,000 requests: headless 14.30 to 13.92 (-2.7%), dashboard 15.54 to 14.71 (-5.3%). Scavenge count does **not** follow bytes closely: V8 sizes the young generation dynamically, so a configuration that allocates less can still scavenge more often per request (the `interceptor` row allocates 26% fewer bytes than headless and scavenges 42% more often). Read the scavenge column as "did not get worse and moved the same way", not as a precise rate.

### Where the 27.5 KB per request goes (headless, after)

Nestrix's "share" of 27.5 KB (headless minus baseline) is mostly not Nestrix's own code:

| part | B/request | how known |
| --- | --- | --- |
| Nest's interceptor machinery, present once any global interceptor is registered (`mergeMap`, `switchMap`, `defer`, `tap`, `OperatorSubscriber` chain in `InterceptorsConsumer`) | **16,624** | measured: `interceptor` config minus baseline. Nestrix's `APP_INTERCEPTOR` is required by the design (handler attribution, exceptions, 404 rule), so this cost is only avoidable by not having an interceptor. |
| Everything else Nestrix adds (server span, its attributes, contexts, the close listener, header picking, the interceptor's own `tap`, and the OpenTelemetry SDK's work on all of it) | **10,849** | measured: headless minus `interceptor` |

In the allocation profile of headless, the biggest items inside that 10.8 KB belong to the OpenTelemetry SDK and API, not to Nestrix (approximate, per request, before the changes below): `isAnyValue` creates a `new WeakSet()` for every attribute value of every `startSpan` and `setAttribute` call (about 1,100 B at start, 540 B at close; this is the "unexplained `WeakSet`" of the phase 1 report); `Object.entries` inside `cleanAttributesInternal` (about 660 B); two `Map` copies of the context per request (`trace.setSpan(...)` then `.setValue(...)`, about 830 B); `startSpan`/`SpanImpl` (about 900 B). Nestrix's own frames were `intercept` (1.6 KB self, mostly `switchToHttp()` and the `tap` observer), `start` (0.9 KB), `finish` (0.6 KB), and `iterateHeaders`/`headerAttributes` with the generator, a pair per header and `Object.entries` at close (about 2.3 KB together).

### Store cost per span (no HTTP)

| | before | after |
| --- | --- | --- |
| store processor, per span (difference) | **7,262 ns** | **1,937 ns** (-73%) |
| SDK span with the processor | 8,847 ns | 3,497 ns |
| SDK span without the processor | 1,586 ns | 1,560 ns |

Repeated after each change (same script, medians of 3 loops): 7,262 (start), 2,598 (after the eviction queue), 2,539 (after the single-pass attribute cleanup), 2,513 (after the id check by loop), 2,013 and 1,864 to 1,929 on two reruns (after the lazy span-id set; the last two rows are the same code, so the run-to-run spread is about 5%).

### Throughput, end to end (`dashboard-after.md`)

| route | headless req/s | dashboard req/s | dashboard vs headless before (P2-12) | after |
| --- | --- | --- | --- | --- |
| GET /hello | 28,166 (was 27,984) | 25,721 (was 23,794) | -15.0% | **-8.7%** |
| GET /users/:id | 27,170 (was 26,897) | 24,875 (was 22,948) | -14.7% | **-8.5%** |
| GET /spans (3 manual spans) | 25,406 (was 25,219) | 22,550 (was 19,978) | -20.8% | **-11.2%** |

Wall cost of the dashboard per request (difference of `1 / throughput`): `/hello` 6.3 to **3.4 us**, `/users/:id` 6.4 to **3.4 us**, `/spans` 10.4 to **5.0 us**. Headless throughput did not change measurably (+0.6% to +1.0%, inside the spread).

## What changed

All behaviour-preserving; every existing test passes unchanged.

| change | where | measured effect |
| --- | --- | --- |
| The store takes its oldest trace from an array queue with a moving head, not from `Map.values().next()`. A `Map` keeps deleted slots until V8 rehashes, so taking the first live entry scanned all the holes in front of it on every eviction once the store was full; `enforceLimits` was **40% of all CPU time** in the micro-benchmark's profile. Eviction order is unchanged (an entry enters the queue where it enters the `Map`, and leaves both only in `evict`). | `packages/nestjs/src/store/store.ts` (`order`, `orderHead`, `enforceLimits`) | micro: 7,262 to 2,598 ns per span. This also explains the "not explained" note in `dashboard.md` about extra spans of a trace costing less than the first: the cost was per eviction, i.e. per new trace. |
| Span ids of a trace are checked by scanning its (at most 8) records; a `Set` is built only for larger traces. | `store.ts` (`hasSpan`, `SMALL_TRACE_SPANS`, `TraceEntry.spanIds`) | micro: about -500 ns per span (2,513 to 2,013). |
| Request header picking walks the container in place (`collectHeaderAttributes`); `headerAttributes` is now a thin wrapper with the same output. The hook collects straight into its attributes object (the prefixed keys never exist there yet), and the close path loops over `Object.keys` instead of `Object.entries`. No generator, no `[name, value]` pair per header, no intermediate object. | `packages/nestjs/src/privacy.ts` (`collectHeaderAttributes`, `addHeader`; `iterateHeaders` removed), `packages/nestjs/src/http/server.ts` (`start`, `finish`) | measured together, not separately: headless 44,191 to 42,391 (-1,800 B per request). |
| The interceptor reads the request with `getArgByIndex(0)` (what `switchToHttp().getRequest()` returns), so `switchToHttp()` no longer assigns three closures onto the host's context object per request. Falls back to `switchToHttp()` for a context without `getArgByIndex`. | `packages/nestjs/src/http/interceptor.ts` (`requestOf`) | headless 42,391 to 42,067 (-324 B per request) together with the store changes below; not separated. |
| Attribute cleanup and byte estimate in one pass over the keys (`cleanAndMeasure` replaces `dropArrayHoles` plus `attributesBytes` on the same object). | `packages/nestjs/src/store/record.ts` | one `Object.keys` array fewer per attributes object; dashboard minus headless fell from 4,176 B to 3,758 B per request across this and the span-id change; CPU effect under the noise. |
| Trace and span id checks use a character loop instead of two regexes. | `record.ts` (`isLowerHex`) | CPU about 15% lower for that function in the profile (404 ms to 343 ms of 9 s); under the noise of the whole. |

Tried and reverted: `stringBytes` with a `charCodeAt` loop instead of its regex. The profile showed it slower (209 ms to 364 ms), so the regex is back.

## Not changed, and why

- **The OpenTelemetry SDK's allocations** (a `WeakSet` per attribute value, `Object.entries`, per-span objects) are in `@opentelemetry/*`. Nestrix could only avoid them by recording fewer attributes, which changes the spans.
- **Two context `Map`s per request** (`trace.setSpan(parent, span).setValue(REQUEST_STATE_KEY, state)`: about 400 B each). Dropping the second needs the route hook to find its state from the active span instead of through Nestrix's own context key (a `WeakMap` keyed by span). That is a change to the request-state design and loses the route when another tool replaces the active span with a child (P0-S3 Q4c'). **Proposal for the lead, not done.** Saves about 400 B per request (1%).
- **The `tap` the interceptor adds to every handler stream** (about 1.5 to 2 KB: `pipe`, `tap`, its `OperatorSubscriber`, the observer and closure). Any replacement still allocates an Observable and a subscriber; not found a cheaper public-API form.
- **Store: two copies of every attribute object per span** (`toRedactable` copies, `toAttributes` validates into a new object). With no `redact` hook, the second copy could return the first when every value is valid, saving about 250 B per span. Skipped: it makes the stored record share an object with the redaction view, which a `redact` hook could keep a reference to, and the SDK 3 `AnyValue` allows nested objects that `toAttributes` drops. That is the store's semantics; proposal only.
- **Run `scrub` once when the exporter path already did**: not applicable. The exporter and the store each redact their own copy at their own time; there is no shared result to reuse.
- The close listener closure per request (`rawRes.once('close', ...)`) and the options object per `startSpan`: small, and removing the closure means putting the request and response on the request state.
