# Standalone server example: several services, several replicas

`docker-compose.yml` runs PostgreSQL, the published Nestrix server image
(`ghcr.io/nestrix-js/nestrix-server:0.6.0@sha256:c9fb43475334430c5bdd30e9302a9009abe12951932380c3951a6483d96822f6`) and two NestJS services from `examples/jaeger`:
`service-a` calls `service-b`, and `service-b` runs as two replicas. Each service has only
`OTEL_EXPORTER_OTLP_ENDPOINT=http://nestrix-server:4318`; the code has no Nestrix setting beyond
`NestrixModule.forRoot({ serviceName })`.

```bash
export NESTRIX_ADMIN_PASSWORD=...   # at least 12 characters
docker compose -f examples/standalone/docker-compose.yml up --build
for i in 1 2 3 4 5 6; do curl -s localhost:3001/call/$i; done
```

Open <http://localhost:4318> and sign in. Both replicas show up as one `service-b`, and the service
map has the `service-a` to `service-b` edge. Open a trace and look at its resource:
`service.instance.id` differs per replica. Nestrix sets a random one per process unless you set the
attribute yourself, for example to the pod name with
`OTEL_RESOURCE_ATTRIBUTES=service.instance.id=$HOSTNAME`.

`NESTRIX_INGEST_AUTH=none` is for this demo only. In real use set `NESTRIX_INGEST_KEYS` on the server
and `OTEL_EXPORTER_OTLP_HEADERS` on each service; `apps/server/README.md` has the details.

The `latest` tag follows the newest stable release and is published by the release workflow; the compose file pins a version and digest instead ([how to move it](../../docs-site/guide/production.md#pinned-images)). To use
your own checkout instead, replace the `image:` line with
`build: { context: ../.., dockerfile: apps/server/Dockerfile }`.

## Historical metrics

The services record runtime metrics (CPU, RSS, heap, event-loop delay, request duration) and send them
to the same endpoint as their traces. The server stores them only with `NESTRIX_METRICS=on`;
`docker-compose.metrics.yml` turns that on:

```bash
export NESTRIX_ADMIN_PASSWORD=...   # at least 12 characters
docker compose -f examples/standalone/docker-compose.yml -f examples/standalone/docker-compose.metrics.yml up --build
for i in $(seq 1 60); do curl -s localhost:3001/call/$i > /dev/null; done
```

Open <http://localhost:4318>, sign in and open **Metrics**. The first points arrive after the first
export (15 seconds in this example; 60 seconds by default) and the charts fill one point per minute.
Both replicas of `service-b` are there: pick the service, then one instance, "One line per
instance", or an aggregation across replicas. Click a chart (or drag across it) to open the requests
from those minutes, and open a trace to follow its "Metrics around this time" link.

The override builds the server from this checkout, because the image pinned in `docker-compose.yml`
is from before the metrics receiver (remove the `build` and `image` lines from the override once the
pin moves to a release that has it). Without the override the server answers `404` for
`/v1/metrics`, the services log one line saying so and keep sending traces, and the dashboard has no
Metrics page. The services export metrics because `@opentelemetry/sdk-metrics` and
`@opentelemetry/exporter-metrics-otlp-http` are installed next to `@nestrix-js/nestjs` (they are optional
peer dependencies of it; see [Exporting metrics](../../docs-site/guide/logs-and-metrics.md#exporting-metrics)).
What the server stores, retention, series limits and backpressure are in
[`apps/server/README.md`](../../apps/server/README.md#historical-metrics-optional).

## Add the server to an existing compose project

Add the server next to your services and point it at a PostgreSQL database (the one in your project
or a new one; `examples/standalone/docker-compose.yml` shows a Postgres service). Give your services
the endpoint and an ingest key:

```yaml
services:
  nestrix-server:
    image: ghcr.io/nestrix-js/nestrix-server:0.6.0@sha256:c9fb43475334430c5bdd30e9302a9009abe12951932380c3951a6483d96822f6
    environment:
      DATABASE_URL: ${NESTRIX_DATABASE_URL:?}
      NESTRIX_INGEST_KEYS: ${NESTRIX_INGEST_KEY:?} # at least 32 characters
      NESTRIX_ADMIN_PASSWORD: ${NESTRIX_ADMIN_PASSWORD:?}
    ports: ["4318:4318"]

  your-service:
    # ...
    environment:
      OTEL_EXPORTER_OTLP_ENDPOINT: http://nestrix-server:4318
      OTEL_EXPORTER_OTLP_HEADERS: authorization=Bearer ${NESTRIX_INGEST_KEY}
```
