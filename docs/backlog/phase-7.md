# Phase 7 backlog: profiler, alerting and SLOs

Objective and deliverables: [roadmap.md](../roadmap.md#phase-7-profiler-alerting-and-slos) and D-56. How to run it: [ai/orchestration.md](../ai/orchestration.md), the delivery mode in `AGENTS.md`, the phase 3 backlog's "Rules for every task". Acceptance and validation are written here, as the roadmap asks, and refined from the spike result. The profiler part depends only on the SDK; alerting and SLOs need the standalone server's stored history (phase 5).

## Status

| ID | Task | Tier | Depends on | Status | Notes |
|---|---|---|---|---|---|
| P7-00 | Backlog | lead | — | done | |
| P7-01 | Spike: profiling a running Nest app on demand | opus | P7-00 | todo | Result in `docs/spikes/P7-S1.md`. |
| P7-02 | Profiler: on-demand capture in the SDK, dashboard endpoint and view | opus + sonnet | P7-01 | todo | Security: review required (first state-changing dashboard action). |
| P7-03 | Alerting rules and webhook notifications in the standalone server | opus | P5-04 | todo | Outbound requests to user URLs: review required. |
| P7-04 | SLOs over stored history in the standalone server, with UI | sonnet | P7-03 | todo | |
| P7-05 | Docs and phase report | sonnet + lead | all | todo | |

## Settled design (before the spike)

- **Profiler: on demand only, never continuous** (D-56). A capture runs for a bounded time (default 30 s, at most 120 s), one at a time per process, through a public Node API (the spike chooses between `node:inspector` `Profiler.start/stop` in the same thread and any newer V8 profiling API Node 26 offers). Profiles are kept in memory (the last three) and downloadable as `.cpuprofile` (Chrome DevTools format), with a top-functions table and a flame graph in the dashboard. Overhead during a capture is measured in the spike (a short benchmark) and stated in the docs; nothing runs when not capturing.
- **Starting a capture is the dashboard's first state-changing action**, so it gets protection beyond the read-only rules of architecture §4.7: `POST` only; `Sec-Fetch-Site` must be `same-origin`; `Origin` must equal the request's host; available only when the dashboard is on and authenticated (`ui.enabled: true` with `auth`, or `'auto'` with the startup token). `ui.profiler: false` disables it.
- **Alerting (standalone server):** rules on route and class statistics from the rollup tables, `error_rate > x` or `p95_ms > y` over a window (5 to 60 minutes), per service and optionally per route; evaluated every minute; states `ok`, `firing`, `resolved`, with a minimum duration against flapping; notifications by webhook (JSON `POST`, body signed with HMAC-SHA256 using a per-rule secret, 5 s timeout, retries with backoff, one in flight per rule). Rules are managed through the admin-protected API (`/api/v1/alerts`) and stored in Postgres. Outbound requests: `http`/`https` only, redirects not followed, private, link-local and loopback addresses refused unless listed in `NESTRIX_WEBHOOK_ALLOWED_HOSTS` (SSRF).
- **SLOs (standalone server):** an objective per service or route, availability (share of non-5xx) or latency (share under a threshold), over a rolling 7 or 30 days, computed from the rollups; the API reports attainment, remaining error budget and burn rate over 1 h and 6 h; burn-rate alerts reuse the alerting engine. A UI page lists SLOs with budget bars.

## Acceptance (delivery mode: functional checks, local)

- A capture started from the dashboard on all three adapters returns a valid `.cpuprofile` (JSON with `nodes`, `samples`, `timeDeltas`), shows the hot function of a CPU-bound test route at the top, and leaves request results unchanged; a cross-site, wrong-origin or unauthenticated request cannot start one.
- An alert rule on a service whose error rate rises above the threshold fires once, sends one signed webhook to a local receiver, and resolves when the rate drops; a webhook to a loopback URL is refused unless allowed.
- An SLO over seeded rollups reports the expected attainment and budget.
