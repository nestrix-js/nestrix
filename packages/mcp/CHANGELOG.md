# @nestrix-js/mcp

## 0.8.0

### Minor Changes

- [#65](https://github.com/nestrix-js/nestrix/pull/65) [`07b7099`](https://github.com/nestrix-js/nestrix/commit/07b709929f20f98a988116ca67900d31d353f249) Thanks [@lamberto15](https://github.com/lamberto15)! - Behaviour change: `@nestrix-js/mcp` now refuses to start when `NESTRIX_URL` is `http://` to a host that is not loopback (`localhost`, `127.0.0.0/8`, `::1`), because `NESTRIX_TOKEN` would be sent as a bearer over plaintext. Use `https://`, or set `NESTRIX_ALLOW_INSECURE_HTTP=1` to keep the old behaviour (a warning on stderr) on a network you trust.

- [#65](https://github.com/nestrix-js/nestrix/pull/65) [`07b7099`](https://github.com/nestrix-js/nestrix/commit/07b709929f20f98a988116ca67900d31d353f249) Thanks [@lamberto15](https://github.com/lamberto15)! - Searchable logs in the standalone server ([#17](https://github.com/nestrix-js/nestrix/issues/17), D-106). Set `NESTRIX_LOGS=all` to store log records without a trace id and keep up to `NESTRIX_LOGS_MAX_PER_TRACE` lines per trace; the default (`trace`) is unchanged. The dashboard gets a Logs page (service, level, text, trace and time filters, cursor paging, truncation and drop counts) and `@nestrix-js/mcp` a `search_logs` tool, both against `GET api/v1/logs`.

- [#65](https://github.com/nestrix-js/nestrix/pull/65) [`07b7099`](https://github.com/nestrix-js/nestrix/commit/07b709929f20f98a988116ca67900d31d353f249) Thanks [@lamberto15](https://github.com/lamberto15)! - Filter traces and errors by tenant, request id and other attributes ([#27](https://github.com/nestrix-js/nestrix/issues/27)). A new opt-in `context(request)` option sets attributes such as `tenant.id` on a request's server span (read once, after guards, like `user`), and `setTraceAttributes()` sets them from a job, a scheduled tick or a handler. `contextPropagation: { keys }` carries the listed keys to the jobs a request queues (as W3C baggage in BullMQ's job metadata, read back by a worker that lists the same keys), and with `outgoing: true` in the `baggage` header of outgoing requests; nothing is propagated by default. The trace list, timeline, errors and error groups take `attr.<key>=<value>` filters (at most 4), offered in the dashboard from `meta.attributeFilters` and in the MCP tools `find_traces` and `list_errors` (`attributes`), and the trace search also finds a trace by its exact recorded `x-request-id`. The standalone server indexes only the keys listed in the new `NESTRIX_INDEXED_ATTRIBUTES` (migration `0017`).

- [#65](https://github.com/nestrix-js/nestrix/pull/65) [`07b7099`](https://github.com/nestrix-js/nestrix/commit/07b709929f20f98a988116ca67900d31d353f249) Thanks [@lamberto15](https://github.com/lamberto15)! - **Upgrade: stop every server replica before starting this version.** Migration `0016_environments.sql` replaces the unique keys of `route_minutes` and `class_minutes` with keys that include `environment`. A 0.6.0 (or older) server still running after the migration fails every ingest transaction (`there is no unique or exclusion constraint matching the ON CONFLICT specification`), so a rolling upgrade (the chart's and the stack's default) is not safe for this release. Back up, scale the server to zero, start the new version (it migrates), then scale back up; the steps are in the server README, "Upgrading to environments (issue [#28](https://github.com/nestrix-js/nestrix/issues/28))", and in the production guide, "Upgrades". Roll back by restoring the backup: a 0.6.0 server cannot ingest on the new schema.
  
  Environments (issue [#28](https://github.com/nestrix-js/nestrix/issues/28), D-101): one standalone server can hold staging and production (or several products) under the same service name and show each separately.
  
  - The environment is `deployment.environment.name` (else `deployment.environment`) of the resource. Every query of the query API takes `environment` beside `service` (absent is every environment, `unset` the data without one), `meta.environments` lists them, and the dashboard has an Environment selector. The embedded dashboard answers empty for another environment than its own.
  - `NESTRIX_INGEST_KEYS` accepts `<environment>:<key>`: data sent with that key is stored under its environment whatever the resource claims, so a staging key cannot write production data.
  - Alert rules and SLOs carry an `environment` (`null` is every environment, as before). The MCP tools take `environment`. The SDK sends its environment with the remote profiling check-in.
  - Standalone server: migration `0016_environments.sql` (see the server README's upgrade notes; **stop every replica first**, as above).
  - Log search (`GET api/v1/logs`, the Logs page, MCP `search_logs`) takes `environment` too. Error groups, their triage state (resolve, ignore, reopen; the triage routes take `environment`) and `new_error_group` alerts are kept per service and environment; the webhook of a `new_error_group` rule carries the group's environment.
  - The Alerts page shows a rule's environment, and lists `new_error_group` rules (read-only) and rules without a service.

- [#65](https://github.com/nestrix-js/nestrix/pull/65) [`07b7099`](https://github.com/nestrix-js/nestrix/commit/07b709929f20f98a988116ca67900d31d353f249) Thanks [@lamberto15](https://github.com/lamberto15)! - Time ranges beyond 60 minutes on the standalone server ([#29](https://github.com/nestrix-js/nestrix/issues/29)). Every aggregate view (routes, overview, classes, queries, map, dependencies, request timeline, error groups) can be read for the last 6 hours, 24 hours, 7 days or 30 days within the server's retention, and the query API also takes `fromUnixMs` + `toUnixMs`. The dashboard's time pickers list the windows the server offers, and the MCP tools take `windowMinutes` of 360, 1440, 10080 and 43200. Buckets grow with the range (1 minute, 5 minutes, 1 hour, 1 day). The embedded dashboard keeps 15 and 60 minutes.

### Patch Changes

- [#65](https://github.com/nestrix-js/nestrix/pull/65) [`07b7099`](https://github.com/nestrix-js/nestrix/commit/07b709929f20f98a988116ca67900d31d353f249) Thanks [@lamberto15](https://github.com/lamberto15)! - Keep failed and slow requests when sampling, and set the rate from the environment ([#43](https://github.com/nestrix-js/nestrix/issues/43), [#30](https://github.com/nestrix-js/nestrix/issues/30)). Below `sampleRate` 1, a trace the ratio leaves out is still recorded until its local root ends and is exported when a span in it failed (`sampling.keepErrors`, on by default) or the root was slower than `sampling.keepSlowerThanMs` (off by default); downstream services still see the ratio's decision. At most 10,000 spans are held per process; drops are counted in `getExportStatus().traces.dropped`. Note: below rate 1 every request now records its spans (`isRecording()` is true on unsampled spans); `sampling: { keepErrors: false }` restores plain head sampling. `NESTRIX_SAMPLE_RATE` sets the rate when `sampleRate` is not set in code. Every exported local root carries `nestrix.sampling.probability`, and the standalone server weights its route counts, error rates, SLOs and alerts by it; the dashboard and MCP wording says those counts are estimates.

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
