# @nestrix-js/mcp

## 0.5.0

### Patch Changes

- [#50](https://github.com/nestrix-js/nestrix/pull/50) [`d677d0b`](https://github.com/nestrix-js/nestrix/commit/d677d0b8b5b3e21d45edea2ed4c33c2cd09e9dd6) Thanks [@lamberto15](https://github.com/lamberto15)! - The MCP server no longer says route statistics "count every request" when it reads the standalone server, where they are counted from the stored spans and reflect the senders' sampling. The sentences about what statistics count now live in one place (the private protocol package) and the dashboard and the MCP tools use the same ones for both modes; tool descriptions state both cases because they are fixed before the server is known. The package READMEs no longer name a version in their status line.

## 0.4.0

No changes in this release.

## 0.3.0

No changes in this release.

## 0.2.0

No changes in this release.

## 0.1.1

### Patch Changes

- [`798c669`](https://github.com/nestrix-js/nestrix/commit/798c6693a4b3de60e58684d4521a5ad9c7201c53) Thanks [@lamberto15](https://github.com/lamberto15)! - The MCP server now reports its real version to the assistant (it said `0.1.0-alpha.2`). The version is read from the package's own `package.json`, so it cannot drift again.

## 0.1.0

### Minor Changes

- 3efd802: New package `@nestrix-js/mcp`: a stdio MCP server that lets an AI assistant read Nestrix data (traces, errors, route and class statistics, the app map) from an embedded dashboard or the standalone server, with `get_trace` and `explain_slowness` written for models (repeated statements, self times, slow spans) and one write tool, `start_profile`, that starts a CPU capture on an embedded dashboard. It shares one version with `@nestrix-js/nestjs` and `@nestrix-js/ui`.

### Patch Changes

- c6c97d6: MCP: never echo the access value in errors; `get_trace` stays bounded on deep or cyclic traces (200 KB cap); telemetry text is kept on one line and results say it is data, not instructions; a refused profiler start explains the reverse-proxy `Host` requirement.

## 0.1.0-alpha.3

### Minor Changes

- 3efd802: New package `@nestrix-js/mcp`: a stdio MCP server that lets an AI assistant read Nestrix data (traces, errors, route and class statistics, the app map) from an embedded dashboard or the standalone server, with `get_trace` and `explain_slowness` written for models (repeated statements, self times, slow spans) and one write tool, `start_profile`, that starts a CPU capture on an embedded dashboard. It shares one version with `@nestrix-js/nestjs` and `@nestrix-js/ui`.

### Patch Changes

- c6c97d6: MCP: never echo the access value in errors; `get_trace` stays bounded on deep or cyclic traces (200 KB cap); telemetry text is kept on one line and results say it is data, not instructions; a refused profiler start explains the reverse-proxy `Host` requirement.
