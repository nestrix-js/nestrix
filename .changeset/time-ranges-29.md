---
"@nestrix-js/ui": minor
"@nestrix-js/mcp": minor
"@nestrix-js/nestjs": minor
---

Time ranges beyond 60 minutes on the standalone server (#29). Every aggregate view (routes, overview, classes, queries, map, dependencies, request timeline, error groups) can be read for the last 6 hours, 24 hours, 7 days or 30 days within the server's retention, and the query API also takes `fromUnixMs` + `toUnixMs`. The dashboard's time pickers list the windows the server offers, and the MCP tools take `windowMinutes` of 360, 1440, 10080 and 43200. Buckets grow with the range (1 minute, 5 minutes, 1 hour, 1 day). The embedded dashboard keeps 15 and 60 minutes.
