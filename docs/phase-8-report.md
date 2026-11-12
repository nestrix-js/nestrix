# Phase 8 report: MCP server and server API tokens

Date: 2026-11-12. Written by the lead under delivery mode (no approval stops; functional checks, local only). The task list is `docs/backlog/phase-8.md`; the decisions are D-73 and D-74.

## 1. Summary

An AI assistant can now read what a Nest app is doing. `@nestrix-js/mcp` is a new published package: a stdio MCP server that the assistant starts, with nine tools over the query API (`overview`, `find_traces`, `get_trace`, `list_errors`, `route_stats`, `class_stats`, `app_map`, `explain_slowness` and `start_profile`). It reads an app's embedded dashboard (with `ui.auth.token`) or the standalone server (with a new read-only API token), and runs nothing inside the host app. The standalone server gained named, revocable API tokens that read the query API and nothing else. Both pieces had independent security reviews, and both reviews found real issues, now fixed. Both were released as `0.1.0-alpha.3` together with phase 9.

## 2. Acceptance (written in `docs/backlog/phase-8.md`)

| Criterion | Result | Evidence |
|---|---|---|
| Against an embedded dashboard and the standalone server, an MCP client can call every tool; `get_trace` names a repeated statement and its count; `explain_slowness` ranks the slowest span name first | **Met** | `packages/mcp/test` (the SDK's in-process client against both kinds of target, with an N+1 fixture). |
| `start_profile` returns the hot function of a CPU-bound route on an embedded dashboard and explains that profiling is embedded-only on the server | **Met** | `packages/mcp/test`. |
| A server API token reads the query API and is refused on the UI, token routes, alert and SLO routes and ingest; a revoked token stops working at once | **Met** | `apps/server/test` (token tests: each refusal, immediate revocation). |

These results are as recorded when the tasks were accepted; the documentation sweep that wrote this report ran only docs checks, not the tests.

## 3. What was done

| Task | Result |
|---|---|
| P8-00 | Backlog; D-73 (a separate `@nestrix-js/mcp` package, runtime dependencies `@modelcontextprotocol/sdk` and `zod` there only) and D-74 (the MCP may read everything the dashboard shows and start a CPU capture; the server gets read-only API tokens). |
| P8-01 | Standalone server API tokens: `nxt_` plus 43 characters, SHA-256 hash and an 8-character display prefix in `api_tokens`, created, listed and revoked from a session (`/api/v1/tokens`, the UI's Settings page), at most 100 active. A token authenticates only `GET`/`HEAD` on the query controller's routes. |
| P8-02 | `@nestrix-js/mcp`: nine tools, `get_trace` and `explain_slowness` written for models, `start_profile` sending the same-origin headers the profiler endpoint requires. |
| P8-03 | Independent reviews of P8-01 and P8-02 (below). |
| P8-04 | READMEs and docs site; released with phase 9 as `0.1.0-alpha.3`. |

## 4. Reviews and their findings

- **P8-01 (tokens).** A single client sending bad tokens could spend the login's global failed-attempt budget and lock every other client's valid tokens out. Fixed: a valid token is checked before the lockout and is never refused by it; refused tokens count toward the global budget, but each client (by socket address) may count only 5 a minute, beyond which its bad tokens answer 429 without being counted. The fix round also made tokens read every query route (`trace/logs` followed when P9-07 landed) and listed active tokens before revoked ones.
- **P8-02 (MCP).** Three findings, all fixed: the access value could appear in error text (it never appears in output now); `get_trace` was unbounded on deep or cyclic traces (now iterative, capped at 200 KB, cycles handled); telemetry text could break out of its line and pass as instructions (kept on one line, and results say they are data, not instructions). A refused profiler start now also explains the reverse-proxy `Host` requirement.
- **Classes "no data in range".** An idle service was reported as having method spans off. The API now reports `methodsState`, and `class_stats` explains the no-data case (see the phase 9 report).

## 5. Decisions

D-73 and D-74 (`docs/decisions.md`).

## 6. Deferred and known limits

- `start_profile` pauses the app briefly (about 10 ms per MB of compiled code) and works on embedded dashboards only; a long duration can exceed an MCP client's tool timeout.
- API tokens have no scopes or expiry: every token reads the whole query API. At most 100 are active.
- The embedded dashboard has a single token (`ui.auth.token`) for tools.
- A new package joining the Changesets fixed group needs hand steps for its first publish (`RELEASING.md`, "Adding a package after the first release").
