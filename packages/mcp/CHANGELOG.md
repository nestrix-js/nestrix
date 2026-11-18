# @nestrix-js/mcp

## 0.7.0

No changes in this release.

## 0.6.0

### Minor Changes

- [#57](https://github.com/nestrix-js/nestrix/pull/57) [`7261822`](https://github.com/nestrix-js/nestrix/commit/7261822213c7f1acec1a8616f11dcba7f4f3c3c0) Thanks [@lamberto15](https://github.com/lamberto15)! - Error tracking (issues [#22](https://github.com/nestrix-js/nestrix/issues/22) to [#25](https://github.com/nestrix-js/nestrix/issues/25), D-93, D-94):
  
  - One thrown error is one occurrence. An exception recorded again on its way up (the controller's method span, the server span) is marked `nestrix.exception.propagated` and no longer counted twice in the error list, the error groups, the dashboard and the MCP tools, in the embedded dashboard and the standalone server. Spans from older SDKs with the same exception on a span and its child count once too.
  - New `recordError(error, attributes?, options?)`: report an error your app handled (from a `@Catch()` filter, for guard and middleware errors; from a job that retries). It records on the local root span of the current trace with `exception.escaped = false`, once per error object per trace, sets error status unless the exception is expected (`fail` overrides), never throws, and does nothing while Nestrix is disabled.
  - Exceptions that map to a status below 500 (`NotFoundException`, `BadRequestException`...) are recorded but marked `nestrix.exception.expected` and left out of error lists and groups; they stay in the trace view. The new `errors.expected` option marks more (classes, names, `RegExp`s, or a predicate) or none (`false`). Route error rates and SLOs are unchanged.
  - Traces get `hasErrors` (any span failed, for example a failed job or an error recorded below the root) and the trace list a `hasErrors=true|false` filter; the dashboard marks such rows "errors inside" and adds an Errors filter, and the MCP `find_traces` tool takes `hasErrors`. The standalone server adds migrations `0012_traces_has_errors.sql` (nullable columns on `traces` and `spans`, no rewrite) and `0013_traces_has_errors_index.sql` (a partial index; see the server README's upgrade notes for its locks).

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
