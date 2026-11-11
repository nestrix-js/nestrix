---
"@nestrix/nestjs": minor
"@nestrix/ui": minor
---

Outbound HTTP client spans for `node:http`/`node:https` and for `fetch`/undici (the copy bundled in Node and the `undici` package), from diagnostics channels: a child span of the active span, `traceparent` sent unless the caller set one, Nestrix's own export requests and suppressed contexts not traced, `ignore.outgoing` honoured, and query values and headers recorded under the privacy defaults.
