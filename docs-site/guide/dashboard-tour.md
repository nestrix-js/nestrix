# Dashboard tour

A walk through every page, in the order of the tabs, saying what each one answers and where its numbers come from. Every page has the same layout: a header with the title, one line on what the page answers, a label that says **counted before sampling** or **from sampled traces** (explained in [Sampling notes](/guide/dashboard#sampling-notes)), and the page's controls; then a strip of KPI tiles; then charts; then tables with bars, chips and sparklines in the rows. Worse is red or amber, better is green, and arrows and words always say it too. The pages work in dark and light themes and at phone width. Where an answer has no previous window or no data for a number, the page shows "—" instead of inventing one. The [Dashboard](/guide/dashboard) page has the details and the options.

## Overview

*Is the app healthy, and what changed?* A health score with a one-sentence verdict, **Needs attention** and **Getting better** (routes, error groups, dependencies, and SLOs on the standalone server, against the previous 15 or 60 minutes, ranked by impact), KPI tiles, latency percentiles with release markers, status and time-by-kind donuts, throughput, the Apdex split. Throughput, error rate, latency and Apdex are **counted before sampling**; the status mix, time by kind and the error and dependency changes are **from sampled traces**, and each card says which.

## Requests

*Which requests just happened, and which were slow or failed?* Tiles for requests, error rate, p95 and the slowest request in the window; a timeline you can drag across to narrow the time range; a filterable list (status, route, method, type, release, user, duration, text; filter sets can be saved by name in your browser) with a duration bar per row. **From sampled traces**, except that the timeline answer also reports the counts.

## Trace

*Where did the time of this one request go?* A summary (duration, spans, service, release, user, omitted spans), the span waterfall coloured by category with a critical-path toggle, time by span kind and by class, the database queries it ran, and the log lines written during it. When the trace was capped, a banner says how many spans were left out; see [Large traces](/guide/large-traces). **From the stored trace.**

## Errors

*What is failing, and is it new?* Errors grouped by type, message and route, with a state (New, Ongoing, Quiet), events over time stacked by exception type, a donut by type, errors by route and a link to every event of a type. **From sampled traces.** The state is derived from the group's series; the API gives no release per group yet, so there is no "Regressed" state.

## Queries

*Which database statements are slow, frequent or run in a loop?* The slowest and most frequent statements as bar charts, and a table with total and mean time, calls per trace and an N+1 badge for statements that ran three or more times in one trace, with example traces. Statement text never contains bind values. **From sampled traces.**

## Routes

*How does each route perform, and how did it change?* Tiles for routes, requests per minute, error rate and worst p95; the slowest routes by p95; a table with p50, p95, p99, errors, a requests trend and the change against the previous window; the latency histogram of the selected route; a **Compare** tab for window against window or release against release. Requests, errors and percentiles are **counted before sampling**; the release comparison and the histogram's links into the list use stored traces.

## Route detail

*Why did this route change?* Opened from a route. A "What changed" summary with ranked findings (a new or N+1 statement, a slower dependency or method, a new error, what got faster), time per request by kind, and tables for statements, methods, dependencies and errors. The KPI tiles and the histogram are **counted before sampling**; the findings and tables are **from up to 2,000 sampled traces per side**. See [Route detail](/guide/route-detail).

## Classes

*Which of my classes cost the most?* Calls, errors, average, total and own time per class, expandable to methods, with a donut of own time by kind (controller, service, repository, processor, guards and pipes, other). Calls, errors and total time are **counted before sampling**; own time is **from sampled traces**. Needs [method spans](/guide/levels#level-2-method-spans).

## Map

*What does the app talk to, and is it healthy?* The app in the centre and what it called, each node marked healthy, degraded, failing or no calls from the error rate and p95 of the calls into it, edge width following call volume, a node list and a side panel with the node's numbers and links. **From sampled traces.**

## Dependencies

*Which database, cache or host is slow or failing?* A health card for each dependency (kind, status, p95, error rate, calls, trend), calls over time, and a table with a link to its slowest call's trace. **From sampled traces.**

## Runtime

*Is the process under pressure?* Event loop delay (p50, p99, max), heap, RSS and CPU over the last hour, with gauges and a word (Normal, Elevated, High) from fixed thresholds. Sampled every 10 seconds from the process; not spans, and **not available on the standalone server**, which does not see your processes.

## Profiler

*Where is the CPU going?* An on-demand CPU profile: a flame graph coloured by origin (your code, `node_modules`, Node built-ins, V8) with a legend, the top functions by self time and CPU by origin. On the standalone server the same tab profiles any instance that opted in. See [Profiler](/guide/dashboard#profiler) and [remote CPU profiling](/guide/standalone-server#remote-cpu-profiling). Not a counted or sampled-trace number: a recording of the process.

## SLOs and Settings

Standalone server only. **SLOs**: a budget ring for each objective, attainment, and the 1 h and 6 h burn rates against a 1x marker; computed from stored history. **Settings**: read-only [API tokens](/guide/mcp) with a copy-once display of a new token (only a hash is stored). The server's login page uses the same look and is still a plain form with no script.
