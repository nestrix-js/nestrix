---
"@nestrix/nestjs": minor
"@nestrix/ui": minor
---

On-demand CPU profiler in the embedded dashboard (D-70). A new Profiler tab starts a capture of 1 to 120 seconds (default 30) with `v8.startCpuProfile`, one at a time per process, and shows a flame graph, the top functions by self time and a `.cpuprofile` download; the last three captures are kept in memory. Nothing is loaded or running between captures. Starting a capture briefly pauses the app (about 10 ms per MB of compiled code); the dashboard shows the last measured pause before you start.

New option `ui.profiler` (default `true`): the profiler is offered only where the dashboard is authenticated (`enabled: true` with `auth`, or `'auto'` with the startup token or `auth`); `false` removes it and its routes. Starting a capture is the dashboard's first state-changing request: besides dashboard access it requires `Sec-Fetch-Site: same-origin`, an `Origin` equal to the server's own origin, a JSON body and a `Content-Length` of at most 1 KB. Behind a reverse proxy, pass the original `Host` header. `meta` gains `profiler: { available, running }`.
