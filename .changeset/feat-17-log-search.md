---
"@nestrix-js/ui": minor
"@nestrix-js/mcp": minor
---

Searchable logs in the standalone server (#17, D-106). Set `NESTRIX_LOGS=all` to store log records without a trace id and keep up to `NESTRIX_LOGS_MAX_PER_TRACE` lines per trace; the default (`trace`) is unchanged. The dashboard gets a Logs page (service, level, text, trace and time filters, cursor paging, truncation and drop counts) and `@nestrix-js/mcp` a `search_logs` tool, both against `GET api/v1/logs`.
