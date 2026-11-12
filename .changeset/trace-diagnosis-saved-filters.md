---
"@nestrix-js/nestjs": patch
"@nestrix-js/ui": patch
---

Dashboard: the trace view opens with "Where the time went" (own time by database, cache, outbound HTTP, messaging, your code and other, as a stacked bar with percentages, plus the top five classes or spans) and a "Critical path" toggle that highlights the spans that determine the trace's end time. Request rows show a duration bar relative to the slowest listed row. The request toolbar can save the current filters under a name (kept in this browser), apply or delete them, and copy a link to the filtered view.
