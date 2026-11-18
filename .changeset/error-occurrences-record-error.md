---
"@nestrix-js/nestjs": minor
"@nestrix-js/ui": minor
"@nestrix-js/mcp": minor
---

Error tracking (issues #22 to #25, D-93, D-94):

- One thrown error is one occurrence. An exception recorded again on its way up (the controller's method span, the server span) is marked `nestrix.exception.propagated` and no longer counted twice in the error list, the error groups, the dashboard and the MCP tools, in the embedded dashboard and the standalone server. Spans from older SDKs with the same exception on a span and its child count once too.
- New `recordError(error, attributes?, options?)`: report an error your app handled (from a `@Catch()` filter, for guard and middleware errors; from a job that retries). It records on the local root span of the current trace with `exception.escaped = false`, once per error object per trace, sets error status unless the exception is expected (`fail` overrides), never throws, and does nothing while Nestrix is disabled.
- Exceptions that map to a status below 500 (`NotFoundException`, `BadRequestException`...) are recorded but marked `nestrix.exception.expected` and left out of error lists and groups; they stay in the trace view. The new `errors.expected` option marks more (classes, names, `RegExp`s, or a predicate) or none (`false`). Route error rates and SLOs are unchanged.
- Traces get `hasErrors` (any span failed, for example a failed job or an error recorded below the root) and the trace list a `hasErrors=true|false` filter; the dashboard marks such rows "errors inside" and adds an Errors filter, and the MCP `find_traces` tool takes `hasErrors`. The standalone server adds migration `0012_traces_has_errors.sql` (a nullable column, no rewrite).
