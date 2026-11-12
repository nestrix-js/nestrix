---
"@nestrix-js/mcp": patch
"@nestrix-js/nestjs": patch
"@nestrix-js/ui": patch
---

MCP: never echo the access value in errors; `get_trace` stays bounded on deep or cyclic traces (200 KB cap); telemetry text is kept on one line and results say it is data, not instructions; a refused profiler start explains the reverse-proxy `Host` requirement.
