---
layout: home
hero:
  name: Nestrix
  text: Observability for NestJS
  tagline: Nest-aware OpenTelemetry tracing. One module, spans for requests, methods, databases and jobs, and an optional dashboard served by your own app.
  actions:
    - theme: brand
      text: Getting started
      link: /guide/getting-started
    - theme: alt
      text: Configuration reference
      link: /reference/configuration
features:
  - title: One module
    details: Import NestrixModule once. Server spans, outgoing HTTP spans and your own spans, exported over OTLP to Jaeger, Tempo, a Collector or any backend that accepts OTLP.
  - title: Closed by default
    details: The dashboard is off unless something positive opens it. No request bodies, bind parameters or unlisted headers are recorded.
  - title: Does not change your app
    details: Every hook catches everything. No Proxy around providers, no patched Nest internals, no second application.
---

::: warning Status
Nestrix is pre-release (alpha). Option names and defaults are settled for 1.0; see [Upgrading from 0.x](/reference/upgrading) and [Compatibility](/reference/compatibility).
:::
