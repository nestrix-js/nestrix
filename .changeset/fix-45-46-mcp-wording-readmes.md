---
"@nestrix-js/mcp": patch
"@nestrix-js/ui": patch
---

The MCP server no longer says route statistics "count every request" when it reads the standalone server, where they are counted from the stored spans and reflect the senders' sampling. The sentences about what statistics count now live in one place (the private protocol package) and the dashboard and the MCP tools use the same ones for both modes; tool descriptions state both cases because they are fixed before the server is known. The package READMEs no longer name a version in their status line.
