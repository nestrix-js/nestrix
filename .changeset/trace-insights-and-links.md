---
"@nestrix-js/nestjs": minor
"@nestrix-js/ui": minor
---

Dashboard: slow (over 100 ms) database spans are highlighted in the trace waterfall, a Queries panel lists statements repeated three or more times with count and total time (picking one highlights its spans), a span's links open the linked trace when it is still in the store, and the request list gains a type filter (All, HTTP, Jobs, Scheduled), release and user filters, and release and user columns that show when a listed trace has them.
