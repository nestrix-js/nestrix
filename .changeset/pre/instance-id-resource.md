---
"@nestrix-js/nestjs": patch
"@nestrix-js/ui": patch
---

Nestrix's own resource now carries a random `service.instance.id` per process, so replicas of one service can be told apart in the standalone server. Set the attribute yourself with `resourceAttributes` or `OTEL_RESOURCE_ATTRIBUTES` to override it.
