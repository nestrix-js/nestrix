---
"@nestrix-js/nestjs": minor
"@nestrix-js/ui": minor
"@nestrix-js/mcp": minor
---

Environments (issue #28, D-101): one standalone server can hold staging and production (or several products) under the same service name and show each separately.

- The environment is `deployment.environment.name` (else `deployment.environment`) of the resource. Every query of the query API takes `environment` beside `service` (absent is every environment, `unset` the data without one), `meta.environments` lists them, and the dashboard has an Environment selector. The embedded dashboard answers empty for another environment than its own.
- `NESTRIX_INGEST_KEYS` accepts `<environment>:<key>`: data sent with that key is stored under its environment whatever the resource claims, so a staging key cannot write production data.
- Alert rules and SLOs carry an `environment` (`null` is every environment, as before). The MCP tools take `environment`. The SDK sends its environment with the remote profiling check-in.
- Standalone server: migration `0016_environments.sql` (see the server README's upgrade notes).
- Log search (`GET api/v1/logs`, the Logs page, MCP `search_logs`) takes `environment` too. Error groups, their triage state (resolve, ignore, reopen; the triage routes take `environment`) and `new_error_group` alerts are kept per service and environment; the webhook of a `new_error_group` rule carries the group's environment.
- The Alerts page shows a rule's environment, and lists `new_error_group` rules (read-only) and rules without a service.
