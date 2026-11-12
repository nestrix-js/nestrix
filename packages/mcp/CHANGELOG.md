# @nestrix-js/mcp

## 0.1.0-alpha.3

### Minor Changes

- 3efd802: New package `@nestrix-js/mcp`: a stdio MCP server that lets an AI assistant read Nestrix data (traces, errors, route and class statistics, the app map) from an embedded dashboard or the standalone server, with `get_trace` and `explain_slowness` written for models (repeated statements, self times, slow spans) and one write tool, `start_profile`, that starts a CPU capture on an embedded dashboard. It shares one version with `@nestrix-js/nestjs` and `@nestrix-js/ui`.

### Patch Changes

- c6c97d6: MCP: never echo the access value in errors; `get_trace` stays bounded on deep or cyclic traces (200 KB cap); telemetry text is kept on one line and results say it is data, not instructions; a refused profiler start explains the reverse-proxy `Host` requirement.
