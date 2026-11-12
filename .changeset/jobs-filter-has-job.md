---
"@nestrix-js/nestjs": patch
"@nestrix-js/ui": patch
---

The request list's "Jobs" filter now means "traces that include job processing": `TraceSummary.hasJob` is true when any span of the trace is a consumer span or has `nestrix.entry = "job"`, and `type=job` matches it whatever the root (a request that enqueued a job appears under both HTTP and Jobs). Such rows get a "job" badge.
