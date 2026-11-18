---
"@nestrix-js/nestjs": minor
"@nestrix-js/ui": minor
"@nestrix-js/mcp": minor
---

Filter traces and errors by tenant, request id and other attributes (#27). A new opt-in `context(request)` option sets attributes such as `tenant.id` on a request's server span (read once, after guards, like `user`), and `setTraceAttributes()` sets them from a job, a scheduled tick or a handler. `contextPropagation: { keys }` carries the listed keys to the jobs a request queues (as W3C baggage in BullMQ's job metadata, read back by a worker that lists the same keys), and with `outgoing: true` in the `baggage` header of outgoing requests; nothing is propagated by default. The trace list, timeline, errors and error groups take `attr.<key>=<value>` filters (at most 4), offered in the dashboard from `meta.attributeFilters` and in the MCP tools `find_traces` and `list_errors` (`attributes`), and the trace search also finds a trace by its exact recorded `x-request-id`. The standalone server indexes only the keys listed in the new `NESTRIX_INDEXED_ATTRIBUTES` (migration `0017`).
