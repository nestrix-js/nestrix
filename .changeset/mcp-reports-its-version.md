---
"@nestrix-js/mcp": patch
---

The MCP server now reports its real version to the assistant (it said `0.1.0-alpha.2`). The version is read from the package's own `package.json`, so it cannot drift again.
