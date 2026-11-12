---
"@nestrix-js/nestjs": minor
"@nestrix-js/ui": minor
---

**Span limits per trace.** One trace now records at most `maxSpansPerTrace` spans in the app (default 10,000; `false` turns the limit off). Spans past it are not recorded but counted by kind, and the totals are written on the trace's root span as `nestrix.trace.spans_dropped` and `nestrix.trace.spans_dropped.<kind>`; route and class statistics still count every call. The standalone server stores at most `NESTRIX_MAX_SPANS_PER_TRACE` spans per trace (default 50,000), always keeping root spans and the spans that carry the counts. The trace view shows how many spans were omitted. Background: a single job (for example a BullMQ job that writes one row at a time) can produce thousands or millions of spans in one trace.
