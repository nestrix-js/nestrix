# Standalone server example: several services, several replicas

`docker-compose.yml` runs PostgreSQL, the published Nestrix server image
(`ghcr.io/nestrix-js/nestrix-server:latest`) and two NestJS services from `examples/jaeger`:
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

The `latest` tag follows the newest stable release and is published by the release workflow. To use
your own checkout instead, replace the `image:` line with
`build: { context: ../.., dockerfile: apps/server/Dockerfile }`.

## Add the server to an existing compose project

Add the server next to your services and point it at a PostgreSQL database (the one in your project
or a new one; `examples/standalone/docker-compose.yml` shows a Postgres service). Give your services
the endpoint and an ingest key:

```yaml
services:
  nestrix-server:
    image: ghcr.io/nestrix-js/nestrix-server:latest
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
