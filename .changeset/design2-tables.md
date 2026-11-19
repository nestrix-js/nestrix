---
"@nestrix-js/ui": patch
---

Dashboard tables: a bar and its number now share one cell, the number above the bar and both right-aligned under the column's own header (Requests duration, Errors events, Routes requests and p95, Map, Classes, Queries, Dependencies, Profiler CPU, loop and self time). Numbers are written one way: percentages have no space and two significant digits ("1.9%", "12%", "<0.1%"), durations too ("0 ms", "4.2 ms", "96 ms", "1.1 s", never "1.00 s"), a share below 100 is never rounded up to "100%", and every negative number and change uses a true minus. A change with no news keeps its arrow. The Settings table uses the shared table header and its key icon is no longer a round, button-like badge.
