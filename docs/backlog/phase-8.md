# Phase 8 backlog: MCP server for AI assistants

Owner, 2026-11-12: "worth adding MCP so an AI model can easily understand the app". Decisions D-73 and D-74 in [decisions.md](../decisions.md). Rules: `AGENTS.md`, the phase 3 backlog's "Rules for every task" (worktree per task, `git commit -s` with the noreply author email, local checks, changesets).

## Status

| ID | Task | Tier | Depends on | Status | Notes |
|---|---|---|---|---|---|
| P8-00 | Backlog, decisions | lead | — | done | |
| P8-01 | Standalone server: read-only API tokens | opus | P8-00 | done | Security fix round applied: valid tokens checked before the lockout, per-client (5/min) limit on refused tokens, tokens read every query route, list shows active tokens first. |
| P8-02 | `@nestrix-js/mcp`: stdio MCP server over the query API | sonnet | P8-00 | done | Security-reviewed; fixes: access value never in output, bounded iterative get_trace (200 KB cap, cycles), one-line telemetry text, data-not-instructions note, 403 explains proxy Host. |
| P8-03 | Reviews of P8-01 and P8-02 | opus reviewer | each | done | Both found real issues (token lockout from one client; secret in error text, unbounded get_trace); fixed. |
| P8-04 | Docs (README, docs site), release | sonnet + lead | all | done | READMEs and docs site updated; release with phase 9. First publish of `@nestrix-js/mcp` is by hand (RELEASING.md). |

## Settled design

- **One package, every mode (D-73).** `@nestrix-js/mcp`, a new published package, run by the AI tool over stdio (`npx @nestrix-js/mcp` or a `command` entry in the client's MCP config). It talks HTTP to one target: an app's embedded dashboard (`NESTRIX_URL=http://localhost:3000/_nestrix`, `NESTRIX_TOKEN` = the app's `ui.auth.token`, sent as `Authorization: Bearer`) or the standalone server (`NESTRIX_URL=http://nestrix-server:4318`, `NESTRIX_TOKEN` = a server API token from P8-01). Nothing new runs inside the host app. It discovers which kind it reached from `GET api/v1/meta` (`mode`).
- **Tools (read):**
  - `overview` — meta (services, release, sampling, store size), the slowest and most failing routes (from `routes`), recent error count; the starting point.
  - `find_traces` — filters of `GET api/v1/traces` (route, method, status, minDurationMs, search, type incl. `job`, release, user, service), limit ≤ 50, compact rows.
  - `get_trace` — one trace rendered for a model: an indented span tree (name, kind, duration, self time, service), with slow spans (> 100 ms or > 20% of the trace), errors with their message and first stack frames, and repeated statements (same `db.query.text` ≥ 3×) called out at the top; attribute noise trimmed; output capped (default 400 spans, the rest summarised).
  - `list_errors`, `route_stats` (window 15/60), `class_stats`, `app_map`.
  - `explain_slowness` — for a route: the p50/p95 from statistics, then the 5 slowest stored traces, aggregated self time by span name and by class, and repeated queries; a short ranked summary.
- **Tool (write, D-74):** `start_profile` — embedded dashboards only (the standalone server has no profiler; the tool says so). Takes `durationSeconds` (1–60, default 15), warns in its description that starting a capture pauses the app briefly (about 10 ms per MB of compiled code), calls `POST api/v1/profiles` with the protections the endpoint requires (JSON body, `Origin` equal to the target's origin and `Sec-Fetch-Site: same-origin`, set by this trusted client alongside the token), then `get_profile` polls and returns the top functions by self time. Honours 409 (one running) and 429 (cool-down) with their messages.
- **Privacy:** the MCP sees exactly what the dashboard shows (already scrubbed and redacted at the source); it never asks for bodies or bind values (they are not stored). It never logs the token. Output it returns is data for the model, not instructions.
- **Server API tokens (D-74, P8-01).** The admin creates a named token in the server (`POST /api/v1/tokens` from a signed-in session; the plain token shown once; stored as a SHA-256 hash with a prefix for display; list and revoke). A token authenticates `GET /api/v1/*` read routes only — never the UI, the token or alert/SLO write routes, never ingest. `Authorization: Bearer <token>`, constant-time comparison of hashes; failures counted by the existing login rate limiter's global budget. A small UI section (standalone mode) to create, list and revoke tokens.
- **Dependencies:** `@modelcontextprotocol/sdk` and `zod` as runtime dependencies of `@nestrix-js/mcp` only (they are what the MCP protocol needs); `@nestrix-js/nestjs` and `@nestrix-js/ui` are unchanged. Versions from the registry.

## Acceptance

- Against a running embedded dashboard and against the standalone server (P8-01 token), an MCP client (the SDK's in-process client in tests) can call every tool; `get_trace` on a trace with an N+1 pattern names the repeated statement and its count; `explain_slowness` ranks the slowest span name first.
- `start_profile` against an embedded dashboard returns the hot function of a CPU-bound route; against the standalone server it explains that profiling is embedded-only.
- A server API token reads the query API and is refused (401/403) on the UI, on token routes, on alert and SLO writes, and on ingest; a revoked token stops working at once.
