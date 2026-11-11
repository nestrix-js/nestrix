---
"@nestrix-js/nestjs": minor
"@nestrix-js/ui": minor
---

App map API. The dashboard serves `GET api/v1/map?windowMinutes=15|60`: the app and what it calls (databases, caches, HTTP hosts, queues), with calls, errors, p50 and p95 per target, built from the sampled traces in the in-memory store. At most 200 nodes; targets past that fold into one `other` node.
