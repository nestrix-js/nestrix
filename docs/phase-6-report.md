# Phase 6 report: logs, metrics and 1.0

Date: 2026-11-11. Written by the lead under delivery mode (no approval stops; functional checks, local only).

## 1. Summary

The signals are rounded out and the API is ready to freeze. `NestrixLogger` puts trace and span ids in Nest's log output and can export logs over OTLP; `http.server.request.duration` and runtime metrics go through the OpenTelemetry metrics API, so a host's `MeterProvider` receives them, and Nestrix exports them itself only when it owns the pipeline. A VitePress documentation site, a compatibility matrix and an upgrade guide exist. An independent 1.0 API review led to the renames and rules in D-69, made while they were still free. No version was bumped and nothing was published: those are the owner's steps.

## 2. Acceptance criteria (roadmap, phase 6)

| Criterion | Result | Evidence |
|---|---|---|
| A documented upgrade path from 0.x | **Met** | `docs/upgrading.md` (every rename and default change from the changesets, before and after); docs site `/reference/upgrading`. |
| The compatibility matrix published | **Met** | `docs/compatibility.md`, each row marked tested / expected / not supported with the test or CI job; docs site `/reference/compatibility`. |
| No open issue labelled as a 1.0 blocker | **Met, with a caveat** | No open issues at all (`gh issue list`, 2026-11-11); the label does not exist. |

Validation: "the full matrix in CI; the examples run as smoke tests against the release candidate". CI on `main` ran green on GitHub (run 43046693547: verify, consume, jaeger, e2e). The nightly "latest 12.x" workflow has never run on GitHub; trigger it once before a release. There is no release candidate yet (owner step).

## 3. What was done

| Task | Result |
|---|---|
| P6-01 | `NestrixLogger` (`ConsoleLogger` subclass, text suffix or JSON fields), `getTraceIds()`, optional OTLP log export through optional peers. Review fixes: the host logger's `redact` now applies to exported bodies; lazy messages run once; exported body capped at 8 KiB. |
| P6-02 | Request-duration histogram recorded before sampling in the response `close` handler; runtime metrics (event loop, heap, RSS, CPU); optional export. Review fixes: the owned meter provider starts at `onApplicationBootstrap`, so a host provider registered in `onModuleInit` wins; `metrics.export`; a teardown race; `url.scheme`. |
| P6-03 | Documentation site in `docs-site/` (`pnpm docs:build`), with an options reference checked against `options.ts`. |
| P6-04 | 1.0 API review; fixes per D-69: one rule for all signals (the host SDK owns them), `ignore.routes` → `ignore.paths`, `methods: false`, type renames, callback typing, `SpanOptions` no longer re-exported, `service.version` on exported metrics (a bug), `SpanRecord.service`, `MetaResponse.mode` required, server error codes; a Stability section. |
| P6-05 | Compatibility matrix, upgrade guide, 1.0 readiness list; `@nestjs/microservices` peer raised to `^12.0.4`. |

## 4. Decisions

D-64 (optional peers for log and metric export), D-65 (opt-in log correlation, nothing patched), D-66 (metrics through the API, before sampling), D-69 (1.0 freeze: signal ownership, renames, off switches, what semver covers, unread `OTEL_*` variables).

## 5. What the owner still does before 1.0 is published

From `docs/backlog/phase-6.md` "1.0 readiness" and `RELEASING.md`: trademark check (O-5); create the `@nestrix` npm organisation; contact for the code of conduct; make the repository public (provenance needs it), then the post-public settings in `docs/decisions.md`; set `NPM_PUBLISH_ENABLED`; exit the Changesets pre mode and add a `major` changeset for 1.0.0; trigger the nightly workflow once.

## 6. Deferred

Benchmarks of log correlation and metric recording cost; runtime metric names are experimental (D-69 (4)).
