# Phase 7 report: profiler, alerting and SLOs

Date: 2026-11-12. Written by the lead under delivery mode (no approval stops; functional checks, local only).

## 1. Summary

You can now find where CPU time goes, and be told when something breaks. The dashboard offers an on-demand CPU profiler (a bounded capture, nothing loaded while idle) with a top-functions table, a flame graph and a `.cpuprofile` download. The standalone server evaluates alert rules on error rate, p95 latency and SLO burn rate every minute and sends signed webhooks, and it tracks availability and latency SLOs with error budgets and burn rates. All three pieces had independent security reviews: the profiler because it is the dashboard's first state-changing action, alerting because it sends requests to user-supplied URLs.

## 2. Acceptance (written in `docs/backlog/phase-7.md`)

| Criterion | Result | Evidence |
|---|---|---|
| A capture from the dashboard on all three adapters returns a valid `.cpuprofile`, shows the hot function of a CPU-bound route at the top, and leaves results unchanged; cross-site, wrong-origin or unauthenticated requests cannot start one | **Met** | `packages/nestjs/test/profiler-acceptance.test.ts` (fresh child process per adapter: `hotRouteWork` on top with 853 to 965 of about 1,600 samples; start pause 47 to 52 ms); `profiler-security.test.ts` (52 refusal cases on three adapters, each checks no capture started and no CORS header). |
| An alert rule fires once, sends one signed webhook to a local receiver, and resolves; a loopback webhook is refused unless allowed | **Met** | `apps/server/test/alerts/api.test.ts`, `webhook.test.ts` (loopback, private, IPv4-mapped and rebinding cases refused; signature verified by the README's example code). |
| An SLO over seeded rollups reports the expected attainment and budget | **Met** | `apps/server/test/slos/unit.test.ts`, `api.test.ts` (availability and latency, 7 and 30 days, burn rates; a burn-rate alert fires through the engine). |

## 3. What was done

| Task | Result |
|---|---|
| P7-01 | Spike (`docs/spikes/P7-S1.md`): `v8.startCpuProfile`; no measurable throughput cost during a capture; a start pause of about 10 ms per MB of compiled code; context and spans unaffected; D-70. |
| P7-02 | Profiler in `@nestrix-js/nestjs` and the dashboard. Review fixes: a 10 s cool-down between captures (429 with `Retry-After`); the UI explains that starting needs HTTPS or localhost (browsers send `Sec-Fetch-Site` only there); a documented note on host body-parser errors. |
| P7-03 | Alerting: rules, evaluator under an advisory lock, signed webhooks with SSRF protection. Review fixes: `eventId` and a delivery header for deduplication, IPv6 global-unicast only, cancellable DNS with one 5 s deadline per attempt, a database check that a rule's threshold suits its metric, a recorded outcome on shutdown. |
| P7-04 | SLOs with error budgets and 1 h / 6 h burn rates; `slo_burn_rate` alerts; a UI page in standalone mode. |
| P7-05 | Docs (README, docs site, architecture §4.6, §4.7, §4.10) and this report. |

## 4. Decisions

D-70 (profiling through `v8.startCpuProfile`, one capture per process, a cool-down, output normalised to `--cpu-prof` form).

## 5. Deferred and known limits

- The profiler samples main-thread JavaScript only, without source maps, and inlined functions can appear under their caller. Starting a capture over plain HTTP to a non-local host is refused by design.
- Alert and SLO management has an API but no alert-rule UI; SLOs have a page.
- A 30-day SLO reads up to 43,200 minute rows per query; not measured.
- Delivery is at most once: a crash between recording an alert event and sending it leaves the notification unsent.
