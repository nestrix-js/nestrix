---
"@nestrix-js/nestjs": minor
"@nestrix-js/ui": minor
---

New **Overview** home page in the dashboard: a health score with a one-sentence verdict, what needs attention and what got better compared with the previous 15 or 60 minutes (routes, errors, dependencies and, on the standalone server, SLOs), KPI tiles with their change, latency percentiles with release markers, donuts for responses by status and where request time goes, and the Apdex split. Served by the new `GET api/v1/overview` on both the embedded dashboard and the standalone server. The request list moves to `/requests`; old links are redirected.

**Remote CPU profiling through the standalone server.** With `export: { profiler: true }` (off by default), an app instance checks in with the standalone server every 15 s over its export endpoint and ingest key; an admin picks an instance in the server's Profiler page and starts a capture, which the instance runs and uploads itself. The server never connects to an instance.
