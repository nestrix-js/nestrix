---
"@nestrix-js/nestjs": minor
"@nestrix-js/ui": minor
---

Releases and users. `service.version` is now set on the Nestrix-owned resource from the new `serviceVersion` option, falling back to `resourceAttributes`, `OTEL_RESOURCE_ATTRIBUTES`, `GIT_SHA` and `npm_package_version`, and the dashboard's `meta` reports it. The opt-in `user` option reads the user behind a request (for example `(req) => req.user?.id`) and records it as `user.id` on the server span; it gets the same request object your guards see on Express, Fastify and platform-node. The query API's trace list gains `type` (`http`, `job`, `scheduled`, `other`), `release` and `user` on each item, and filters by all three.
