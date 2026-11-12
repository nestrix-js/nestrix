# MCP server for AI assistants

`@nestrix-js/mcp` lets an AI assistant such as Claude Code, Claude Desktop or Cursor read what your app is doing: slow routes, failing requests, one trace at a time, repeated database statements, and a CPU profile on request. The assistant starts it as a small program over stdio. It talks HTTP to Nestrix, so nothing new runs inside your app, and it works with both an app's embedded dashboard and the standalone server.

::: warning Status
Alpha, published with the other packages under the `alpha` tag. Needs Node 26.13 or later.
:::

## Point it at a target

| Target | `NESTRIX_URL` | `NESTRIX_TOKEN` |
|---|---|---|
| An app's embedded dashboard | `http://localhost:3000/_nestrix` | the app's `ui.auth.token` |
| The standalone server | `http://nestrix-server:4318` | a server API token (read-only, revocable) |

For the embedded dashboard the app must run `ui: { enabled: true, auth: { token } }` (a token of 32 characters or more). The default `ui: 'auto'` cannot be used: its startup token is a browser cookie flow. A wrong token gets a `404` from the dashboard, by design, and the MCP server reports it as "not a Nestrix dashboard or server, or wrong token".

## Add it to your assistant

Claude Desktop, Cursor and most other clients take a JSON entry that names the program and its environment:

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

For Claude Code, the `claude mcp add` command with the same two variables is in the [package README](https://github.com/nestrix-js/nestrix/blob/main/packages/mcp/README.md#client-configuration).

`NESTRIX_TIMEOUT_MS` (100 to 120000, default 10000) sets the per-request timeout. Use `https://` for anything beyond your own machine.

## Tools

`overview`, `find_traces`, `get_trace`, `list_errors`, `route_stats`, `class_stats`, `app_map`, `explain_slowness` and `start_profile`. Ask in plain language, for example "why is `GET /orders` slow?": the assistant calls `explain_slowness`, then `get_trace` on the slowest request. `get_trace` puts repeated statements (the same SQL three or more times, a likely N+1) at the top, then errors with their first stack frames, slow spans and an indented span tree with self times. Output is compact, deterministic and truncated with a note. The [package README](https://github.com/nestrix-js/nestrix/blob/main/packages/mcp/README.md) says what each tool does.

## What the assistant can see

Exactly what the dashboard shows, already scrubbed inside your app: span names, timings, allow-listed attributes, SQL text without bind values, error messages and stack traces. Request and response bodies, bind parameters and other headers are not stored, so they cannot be read. Traces are sampled and in memory; route statistics count every request. Telemetry text can contain anything, so the server tells the model to treat it as data.

## `start_profile` pauses the app

The one write: it starts a CPU capture on an embedded dashboard and returns the hottest functions. **Starting a capture pauses the whole app briefly** (about 10 ms per MB of compiled code; tens of milliseconds in a small app). Do not use it on production without agreement. One capture at a time, at least 10 seconds apart; the standalone server has no profiler and the tool says so.
