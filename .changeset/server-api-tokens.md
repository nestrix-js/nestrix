---
"@nestrix-js/nestjs": patch
"@nestrix-js/ui": patch
---

The standalone server gains read-only, revocable API tokens for tools such as the MCP server: `Authorization: Bearer nxt_…` reads the query API's read routes (meta, traces, trace, errors, routes, classes, map) and nothing else. The dashboard has a Settings page, shown only by the standalone server, to create a token (shown once, with a copy button), list tokens and revoke them.
