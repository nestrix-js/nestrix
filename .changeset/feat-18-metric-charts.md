---
"@nestrix-js/ui": minor
---

Metric charts in the standalone dashboard (#18, D-105). With `NESTRIX_METRICS=on` the dashboard gets a Metrics page: CPU, memory, heap, event-loop delay and request duration over the shared time windows or an exact range, by service, environment and instance, with the aggregation across replicas or one line per instance, units from the catalog, gaps shown as gaps, and empty, stale and capped notes. Clicking or dragging across a chart opens the requests from those minutes in the same service and environment, and a trace page links to the metrics around it. The page and its menu entry exist only when `meta.metrics.available` is true, so tracing-only installs see no change.
