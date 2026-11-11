# Phase 2 report: embedded dashboard (0.1.0)

Date: 2026-11-11. Written by the lead for the owner at the phase 2 gate. **Approved by the owner on 2026-11-11**, with one commit per task, a push, and `@nestrix/ui` confirmed as an optional peer (D-54).

## 1. Summary

A Nest 12 app with `@nestrix/nestjs` and `@nestrix/ui` installed now shows its own traces at `/_nestrix`, with nothing else running: a live request list, the trace waterfall, an error list and per-route latency and error-rate charts. The dashboard mounts on Express, Fastify and platform-node, is closed unless something positive opens it (local-only plus a startup token by default; token or custom `authorize` elsewhere), never emits CORS headers, and its route statistics stay correct at any sample rate. Every piece of request-path or access-control code had an independent review; each review found real defects, all fixed before the task was marked done.

Nothing is committed, pushed or published. All phase 2 work is in the working tree.

## 2. Acceptance criteria (roadmap, phase 2)

| Criterion | Result | Evidence |
|---|---|---|
| Works in the Express, Fastify and platform-node example apps, with and without a global prefix, with `app.useSecurityHeaders()`, and with host CORS | **Met** | `e2e/tests/dashboard.pw.ts` (real apps in Chromium: main flow, global prefix, security headers, host CORS, per adapter, plus CommonJS Express); `packages/nestjs/test/dashboard-mount.test.ts` (also URI versioning, Fastify `preSerialization` CORS, `@nestjs/testing`) |
| A non-loopback request, a forwarding header, or `Sec-Fetch-Site: cross-site` gets no dashboard data in the default mode | **Met** | `packages/nestjs/test/dashboard-security.test.ts`: LAN-address peer, each of the six forwarding headers, cross-site in every mode, on three adapters over raw sockets |
| In `'auto'`, no data without the startup token cookie, including through a same-host reverse proxy that adds no forwarding headers; the logged link sets the cookie; the opt-out disables the check | **Met** | Same file: a real proxy process that rewrites `Host` is refused without the cookie and admitted with `startupToken: false`; the e2e flows open the logged link and load data |
| `NODE_ENV=production` with no `auth`: unreachable, the app starts | **Met** | e2e "NODE_ENV=production without auth"; security and behaviour tests (nothing registered) |
| A host catch-all on Express is reported as shadowing | **Met** | e2e "a host catch-all"; `stats-http.test.ts`, `dashboard-behaviour.test.ts` |
| At sample rate 0.1, per-route counts match requests sent; the UI shows lists are sampled | **Met** | e2e "sampleRate 0.1" (40 sent, 40 counted, notice shown); `stats-sampling.test.ts` on three adapters (exact counts over 400 requests incl. a 404 and a thrown 500) |
| `@nestrix/ui` within its unpacked-size budget, checked in CI | **Met** | 762,338 bytes against 1,000,000 (D-53); `packages/ui/scripts/check-size.mjs` runs in `check:package`, which `pnpm verify` and CI run |
| A Playwright test opens a trace and checks the waterfall rows | **Met** | Every e2e flow: the `/out` trace has 5 rows at levels 1, 2, 3, 2, 3 with their names |

Validation: "Playwright against the example apps in CI" — the `e2e` job is in `.github/workflows/ci.yml` and passes under `act`; it has **not run on GitHub** (nothing pushed). "A security test file with one test per rule in §4.7" — `dashboard-security.test.ts`, 82 tests; a reviewer injected 13 different breaks into the access code and all are caught.

Final checks on the working tree: `pnpm verify` exit 0 (build; publint and attw "All good!"; `check-no-tla` passed; 1,941 tests passed, 57 skipped (database tests without Docker); Biome clean apart from the 7 existing warnings in spike files; `tsc -b` clean). `pnpm --filter e2e test`: 16 passed. `pnpm --filter @nestrix/ui e2e`: 89 passed, 1 skipped (a clipboard test that only runs in Chromium). `pnpm changeset status --since=origin/main` fails only because `.changeset/embedded-dashboard.md` is untracked; it passes once committed.

## 3. What was done

| Task | Check that showed it |
|---|---|
| P2-00 Backlog, option types | `docs/backlog/phase-2.md`; `ui` and `store` in `src/options.ts` |
| P2-01 Query API types | 12 tests and 7 type-level drift checks in `packages/protocol` |
| P2-02 UI foundation | 548 KB first build; no CSP violation in Chromium and Firefox at a non-root `<base href>`; nuqs checks (D-53) |
| P2-03 Store and `nestrixSpanProcessor()` | store tests; reviewed, fixes: drain under suppress-tracing (a span-creating `redact` hook hung flush), two-byte string cost, duplicate processors, poll `reset`, one error rule |
| P2-04 Route statistics, dashboard path in the hook | exact counts at 0.1 on three adapters; reviewed, fixes: shadowing only for GET/HEAD non-404, async callback guarded, absolute-form targets |
| P2-05 Access control, startup token | 329 tests; reviewed and security-reviewed (no bypass found); fixes: cookie lock-out, `Secure` outside loopback, per-process salt, `resolveUi` never throws |
| P2-06 Mounting, assets, API | 69 dashboard tests on three adapters; reviewed, fixes: link logged after a slow start, case-insensitive path match, bare denied 404, HEAD tests |
| P2-07 Security tests | 82 tests; reviewed (13 injected breaks, all caught after the fix round) |
| P2-08/09/10 UI views | 89 Playwright + 48 unit tests; 5,000-span trace keeps about 60 rows in the DOM |
| P2-11 End-to-end, CI job | 16 Playwright tests against real apps; job passes under `act` |
| P2-12 Store limits, dashboard benchmark | `benchmarks/results/dashboard.md` |
| P2-13 Documentation | README "Dashboard" section and options; UI README; architecture §4.5–§8; doc review applied |
| P2-14 Lazy exporter | child-process test: 0 exporter modules loaded with export off; startup −16 ms, heap −1.1 MB |
| P2-15 Per-request cost | `benchmarks/results/allocation.md`; reviewed (old and new fuzzed side by side: identical) |
| P2-16 Flaky tests | `pnpm test` passed three times in a row |
| After the report: two bugs found by looking at the dashboard with real traffic | Fixed with tests that fail without the fix: (1) a trace where the app calls itself was sometimes labelled with the inner request (a start-time tie in root selection; the root is now the earliest span whose parent is not in the trace); (2) the routes latency chart drew nothing for a route with data in one minute (markers now shown for isolated points). `pnpm vitest run packages/nestjs packages/protocol`: 1,232 passed; e2e 16 passed; UI e2e 91 passed |

## 4. What changed from the plan

Owner decision:
- **D-53** (amends D-52): nuqs with a small in-repo adapter, because the stock TanStack Router adapter drops other filters under hash URLs; version 0.x is not a reason to reject a package; measured size recorded (budget stays 1 MB).

Decisions the lead made inside phase 2 (no decision-log entry changed):
- **Shadowing detection is passive** (architecture §4.6 left it to phase 2): logged once when a GET/HEAD under the dashboard path is answered by something else with a status other than 404. No startup self-request.
- **One error rule everywhere:** a span is an error when its status is `error` (for server spans a 5xx); a thrown 4xx keeps its exception event but is not counted.
- **Denied requests get a bare 404** with only `Cache-Control: no-store` and `nosniff`. The default path is well known, so this hides detail, not existence.
- **The production token may still be exchanged through the `?token=` link** (the only browser path without a form); its cookie is `Secure` outside loopback and salted per process, and the README warns that the link lands in proxy logs.
- **Store defaults:** 5,000 traces / 32 MiB, from measurement (a typical trace is about 4 KB of heap).
- **The e2e suite has its own app entries** under `e2e/apps/*`, importing the examples' modules: the examples are test fixtures of `@nestrix/nestjs`, so making them depend on it would be a build cycle.
- **`@nestrix/ui` is an optional peer of `@nestrix/nestjs`** (same version), as a reading of D-3, not a new runtime dependency. Raised in the backlog; not yet confirmed by the owner.

Facts that corrected the docs or the spike:
- The spike's loopback rule let a request with two `Host` headers through (Node keeps the first in `headers`); every `Host` line on the wire is now checked.
- Express routes are case-insensitive, so `/_NESTRIX` reached the dashboard while being traced; the hook now matches case-insensitively.
- The "unexplained `WeakSet`" in the phase 1 memory report is the OpenTelemetry SDK's (`isAnyValue` in `@opentelemetry/core`), not Nestrix's.
- `NODE_ENV=development` with no `ui` option now turns the dashboard on for every app that has `@nestrix/ui` installed; the whole suite was run that way and passes.

## 5. Known limits and open items

- **Cost of the dashboard.** With it on, a trivial route loses about 8.7% throughput (about 3.4 µs per request; it was 15% before P2-15). On any route that does real work it is under 1%. `'auto'` also turns the dashboard on when `NODE_ENV` is unset, if `@nestrix/ui` is installed.
- **Preflight.** `OPTIONS` requests for dashboard paths are answered by the host's CORS layer with its allow headers (architecture §4.7). Acceptable only while the API is read-only.
- **`Sec-Fetch-Site: same-site`** (another localhost port) is allowed, per D-30. Proposal below.
- **CI has never run on GitHub**, including the new `e2e` job.
- **The UI looks plain.** It works and passes the security checks, with stock shadcn styling and no design pass.
- **P2-15 proposals not done:** dropping one context `Map` per request (about 400 B; changes the request-state design, so it goes to Opus) and skipping a second attribute copy in the store (about 250 B per span; changes store semantics).
- **Install size** is now 19.8 MB added (phase 1: 19.4 MB), still dominated by OpenTelemetry packages; the package itself is 630 kB unpacked.
- **Process hygiene:** the agent fixing those two bugs stopped its test app with a broad `pkill -f` pattern, which also stopped the owner's running demo app; orchestration forbids that. No work was lost.
- **Not covered:** WebKit; HTTP/2; the dashboard open and polling during a benchmark; a long soak.

## 6. Cost

Opus (`architect`) built the four request-path and security pieces the first time (store, statistics, access control, mounting) and Opus (`reviewer`) reviewed them, the security tests and the performance changes. Every fix round with an exact list, the UI, the tests, the measurements and the docs went to Sonnet; two small tasks to Haiku. Fable was not used. Benchmarks were short (the longest single run 2 minutes 8 seconds; about 20 minutes in total across P2-12 and P2-15) and never ran alongside another benchmark. One stop at the usage limit cost a restart of wave 1.

## 7. What needs the owner

- **Review this report and decide whether phase 2 is accepted.** Phase 3 (providers, data and jobs) would start in a fresh session.
- **Commits.** Nothing from phase 2 is committed. Say whether to commit it, and whether as one commit or per task.
- **Push**, so CI (including the new `e2e` job) runs on GitHub for the first time.
- **Confirm `@nestrix/ui` as an optional peer** of `@nestrix/nestjs` (lead's reading of D-3).
- **Optional: reject `Sec-Fetch-Site: same-site` too** (changes D-30; defence in depth only).
- **Optional: schedule a visual design pass** on the dashboard.
- Unchanged from earlier phases: O-4 (MongoDB spans), O-5 (trademark search), the `@nestrix` npm organisation, the `CODE_OF_CONDUCT.md` contact, and when the repository goes public.
