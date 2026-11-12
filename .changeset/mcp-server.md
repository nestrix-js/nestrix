---
"@nestrix-js/mcp": minor
"@nestrix-js/nestjs": minor
"@nestrix-js/ui": minor
---

New package `@nestrix-js/mcp`: a stdio MCP server that lets an AI assistant read Nestrix data (traces, errors, route and class statistics, the app map) from an embedded dashboard or the standalone server, with `get_trace` and `explain_slowness` written for models (repeated statements, self times, slow spans) and one write tool, `start_profile`, that starts a CPU capture on an embedded dashboard. It shares one version with `@nestrix-js/nestjs` and `@nestrix-js/ui`.
