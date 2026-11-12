# Phase 10 report: remote CPU profiling

Date: 2026-11-12. Written by the lead under delivery mode: local per-task checks, runs under about 3 minutes, CI on `main` as the safety net (`docs/backlog/phase-10.md`).

## 1. Summary

The standalone dashboard can now profile each app instance (D-76, amending D-70, which gave the standalone server no profiler). An app that opts in with `export.profiler: true` (default off) checks in with the server every 15 s over its export endpoint, using its ingest key. An admin picks an instance on the Profiler page and starts a capture; the instance receives the order at its next check-in, runs the existing on-demand capture (same limits, one slot per process, 10 s cool-down) and uploads the `.cpuprofile`. The server never connects to an instance, so this works behind load balancers and NAT, and an app that does not opt in cannot have its main thread paused from outside. Shipped in `0.1.0` with phase 11.

## 2. Acceptance

The phase file states a delivery rule and a status table; each task was accepted by its tests, and P10-04 added the end-to-end check and the review.

| Check | Result | Evidence |
|---|---|---|
| Poller: check-in body and headers, order, gzip upload that parses as a `.cpuprofile`, 404 stops polling, 401 backs off, a refused start sends `failed`, shutdown stops the timer, no spans for the poller's own requests, option off sends nothing | **Met** | `packages/nestjs/test/profiler-remote*.test.ts` (`-spans` fails when the suppress key is removed; `-exit` runs a child process on `dist`). |
| Server routes: check-in upsert and order handoff, upload by the right instance and key, refusal of others, failed, expiry, `POST remote-profiles` refused for API tokens, cross-site and wrong origin, unknown instance, duplicates, cool-down, `GET instances` window | **Met** | `apps/server/test/profiler/`. |
| UI: Profiler in the nav only for standalone with `remote`, capture flow pending, running, done, detail, empty state | **Met** | Playwright on Chromium against `e2e/mock-api.ts`, plus unit tests of the helpers. |
| End to end against real parts | **Met** | A real PostgreSQL, the server and an app with `export.profiler: true`: a 3 s capture started through the API was `done` in about 19 s (one 15 s check-in interval plus the capture); a start with an API token and a cross-site start were refused. |

Not run: a full `pnpm verify` and the Docker end-to-end (by the delivery rule).

## 3. What was done

| Task | Result |
|---|---|
| P10-00 | D-76, protocol types (`packages/protocol/src/remote-profiles.ts`, `MetaProfiler.remote`), backlog. |
| P10-01 | SDK: `export.profiler` option; `RemoteProfilerPoller` (`src/profiler/remote.ts`) with jitter, backoff and the 404/405 stop; `Profiler.start` gained an optional completion callback; its own requests are suppressed so they create no spans. |
| P10-02 | Server: check-in, upload and failure routes on the ingest port (same key check, rate limit and memory budget as traces), `instances` and `remote-profiles` query routes, expiry and retention, migration `0008_remote_profiles.sql`, summary code copied from the SDK with a drift test. |
| P10-03 | UI: the standalone Profiler page (instances, capture with 15 to 120 s choice, history, detail sharing the embedded page's components). |
| P10-04 | End-to-end check, Opus security review and fixes, docs, changeset `overview-and-remote-profiling`. |

## 4. Reviews and their findings

The Opus review of P10-01 (host process) and P10-02 (a new state-changing route and an untrusted upload) found five issues. Four were fixed in P10-04:

1. A base URL taken from `OTEL_EXPORTER_OTLP_ENDPOINT` also received `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, which belong to the traces URL and could carry the ingest key to another host. It now gets only the generic and option headers.
2. Ownership of an instance was tied to the key's index in `NESTRIX_INGEST_KEYS`, so reordering or rotating keys orphaned instances. The principal is now a fingerprint of the key (first 16 hex characters of its SHA-256).
3. A request in flight could keep a short-lived host process alive. The poller now sends through `node:http`/`node:https` with unref'ed sockets.
4. A capture order could be lost when the instance did not receive it. A `running` capture older than 20 s that the instance does not report is now marked `failed`.

## 5. Decisions

D-76 (the design above). The conservative choices taken inside it: off by default, one instance per click, admin session only (API tokens stay read-only, D-74), the 15 s check-in interval fixed by the server.

## 6. Deferred and known limits

- **Upload memory accounting** (review finding 5). While an upload is read, decompressed and normalised, the copies held at once are not all charged to the server's memory budget. The exposure is bounded: an upload exists only for a capture an admin started, one per instance. Count the peak in the budget, or stream the parse, in the optimisation pass.
- No benchmark of the check-in load with many instances.
- A capture waits for the next check-in, so it starts up to 15 s (plus jitter) after the click.
- Source maps are not applied and worker threads are not included, as in the embedded profiler.
- The optimisation pass stays deferred (D-72).
