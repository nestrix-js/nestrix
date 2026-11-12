# @nestrix-js/mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant (Claude Code, Claude Desktop, Cursor and others) read what your NestJS app is doing through [Nestrix](https://github.com/nestrix-js/nestrix): requests as traces, errors, per-route and per-class statistics, and what the app calls. It is a small program the assistant starts over stdio. It talks HTTP to Nestrix and runs nothing inside your app.

> **Status: alpha.** Needs Node 26.13 or later.

## What it can do

| Tool | What it is for |
|---|---|
| `overview` | Start here: the app, sampling, store size, the slowest and most failing routes, the stored error count. |
| `find_traces` | List stored traces with filters (route, method, status, minimum duration, text, type, release, user, service). |
| `get_trace` | One trace written for a model: repeated statements (a likely N+1) first, then errors with the first three stack frames, slow spans, and an indented span tree with self times. Capped at about 400 spans. |
| `list_errors` | Recent errors grouped by type and message, with trace ids. |
| `route_stats` | Request count, error rate and p50/p95/p99 per route over 15 or 60 minutes. |
| `class_stats` | Per-class calls, errors and own time (needs `NestrixInstrument` in the app). |
| `app_map` | What the app talks to: databases, caches, queues, outbound HTTP. |
| `explain_slowness` | For one route: its percentiles, then where the time goes in its 5 slowest stored traces, by span name and class, with repeated statements. |
| `start_profile` | Takes a CPU profile of the running app and returns the hottest functions. Embedded dashboards only. See [the warning](#start_profile-pauses-the-app). |

Everything except `start_profile` only reads.

## Two targets

`NESTRIX_URL` is either of:

- **An app's embedded dashboard**, for example `http://localhost:3000/_nestrix` (the dashboard's path, including a global prefix if you set one). `NESTRIX_TOKEN` is the app's `ui.auth.token`. The app must run the dashboard with a token:

  ```ts
  NestrixModule.forRoot({
    ui: { enabled: true, auth: { token: process.env.NESTRIX_UI_TOKEN } }, // 32 characters or more
  });
  ```

  The default `ui: 'auto'` is not enough: its startup token is a browser cookie flow and cannot be used by a tool. The dashboard answers `404` to a wrong token (so that it does not reveal itself), and this server reports that as "not a Nestrix dashboard or server, or wrong token".

- **The Nestrix server** (`@nestrix-js/server`), for example `http://nestrix-server:4318`. `NESTRIX_TOKEN` is a server API token: read-only and revocable, created in the server's settings.

| Variable | |
|---|---|
| `NESTRIX_URL` | Required. Base URL of the dashboard or server. A trailing slash is ignored. |
| `NESTRIX_TOKEN` | Required. Sent as `Authorization: Bearer <token>`, never in a URL and never logged. |
| `NESTRIX_TIMEOUT_MS` | Optional. Per-request timeout, 100 to 120000, default 10000. |

Use `https://` for anything that is not on your own machine: the token otherwise travels unencrypted (the program warns on stderr).

## Client configuration

**Claude Code**

```bash
claude mcp add nestrix \
  --env NESTRIX_URL=http://localhost:3000/_nestrix \
  --env NESTRIX_TOKEN="$NESTRIX_UI_TOKEN" \
  -- npx -y @nestrix-js/mcp@alpha
```

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "nestrix": {
      "command": "npx",
      "args": ["-y", "@nestrix-js/mcp@alpha"],
      "env": {
        "NESTRIX_URL": "http://localhost:3000/_nestrix",
        "NESTRIX_TOKEN": "the app's ui.auth.token"
      }
    }
  }
}
```

Keep the token out of files you commit: most clients can read it from your environment instead of a literal value.

## What the assistant can and cannot see

It sees exactly what the dashboard shows, which is already scrubbed and redacted inside your app (the `redact` hook and the privacy defaults apply): span names, timings, the allow-listed attributes, SQL statement text without bind values, error messages and stack traces. Request and response bodies, bind parameters and headers outside the allowlist are never stored, so they cannot be read. Traces are sampled and kept in memory, so a rare or old request may be missing; `route_stats` counts every request.

Text a tool returns is telemetry from your application: a span name or an error message can contain anything. The server tells the model to treat it as data, but give the assistant only the access you would give a colleague reading the dashboard.

A server API token can read the query API and nothing else: it is refused by the UI, token management, alert and SLO writes, and ingest.

## `start_profile` pauses the app

`start_profile` is the only tool that changes anything: it starts a CPU capture in the running app and waits for it to end (default 15 seconds, at most 60), then returns the top functions by self time.

- **Starting a capture pauses the whole app briefly**: about 10 ms per MB of compiled code, tens of milliseconds in a small app, a few hundred in a large one. Requests arriving meanwhile wait. Do not run it against production without the owner's agreement.
- One capture runs at a time (a second start is answered with "already running"), and a new one cannot start within 10 seconds of the last.
- Generate the traffic you want profiled while it runs; an idle app returns an empty profile.
- It works only on an embedded dashboard whose profiler is available (see `overview`). The Nestrix server has no profiler, and the tool says so.
- It sends what the endpoint requires from a trusted caller: a JSON body, an `Origin` equal to `NESTRIX_URL`'s origin and `Sec-Fetch-Site: same-origin`, along with the token.
- A long duration can exceed the tool timeout of your client.

## Errors you may see

| Message | Meaning |
|---|---|
| `NESTRIX_URL is not set` / `NESTRIX_TOKEN is not set` | The environment of the MCP entry is incomplete. The program exits with this on stderr. |
| `Nestrix refused the request (HTTP 401)` or `403` | Check `NESTRIX_TOKEN`. |
| `NESTRIX_URL is not a Nestrix dashboard or server` | `GET api/v1/meta` answered 404: wrong base path, or an embedded dashboard rejecting the token. |
| `Could not reach ...` / `No answer from ...` | The app or server is not running at that URL, or is too slow (`NESTRIX_TIMEOUT_MS`). |

## Licence

Apache-2.0.
