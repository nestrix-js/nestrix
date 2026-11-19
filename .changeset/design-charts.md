---
"@nestrix-js/ui": patch
---

Dashboard charts share one style and fixed series colours. The uPlot charts (route detail, Metrics, Runtime, the requests timeline) drop uPlot's raw legend for the kit legend, write times as HH:mm (dates only across midnight) and values through the page's formatters; the SVG charts get labelled gridlines. p50, p95 and p99 have the same colour on every page and the previous window is dashed; red and green are no longer series colours; stacked fills are opaque. Amount bars are blue instead of green, red or amber. The latency histogram's percentile labels sit above the plot, the Requests table box ends on a whole row, and Map edge labels sit beside the edge. The Metrics unit caption now matches the axis (ms, not seconds).
