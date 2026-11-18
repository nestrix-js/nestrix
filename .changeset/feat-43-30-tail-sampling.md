---
"@nestrix-js/nestjs": minor
"@nestrix-js/mcp": patch
"@nestrix-js/ui": patch
---

Keep failed and slow requests when sampling, and set the rate from the environment (#43, #30). Below `sampleRate` 1, a trace the ratio leaves out is still recorded until its local root ends and is exported when a span in it failed (`sampling.keepErrors`, on by default) or the root was slower than `sampling.keepSlowerThanMs` (off by default); downstream services still see the ratio's decision. At most 10,000 spans are held per process; drops are counted in `getExportStatus().traces.dropped`. Note: below rate 1 every request now records its spans (`isRecording()` is true on unsampled spans); `sampling: { keepErrors: false }` restores plain head sampling. `NESTRIX_SAMPLE_RATE` sets the rate when `sampleRate` is not set in code. Every exported local root carries `nestrix.sampling.probability`, and the standalone server weights its route counts, error rates, SLOs and alerts by it; the dashboard and MCP wording says those counts are estimates.
