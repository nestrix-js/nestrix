# @nestrix/server

The standalone Nestrix server: an OTLP/HTTP receiver, PostgreSQL storage, the query API and the dashboard, on one port. (The full README is written in P5-08.)

## Run with Docker

```bash
cd apps/server
cp example.env .env        # then set NESTRIX_ADMIN_PASSWORD (at least 12 characters)
docker compose up --build
```

This starts PostgreSQL 18 and the server on <http://localhost:4318>. Sign in at `/login` with the admin password. Point any OpenTelemetry-instrumented service at it with one variable:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

The compose file sets `NESTRIX_INGEST_AUTH=none`, so any client that can reach the port may send spans without a key. That is for a local demo only. For anything shared, remove it and set `NESTRIX_INGEST_KEYS` (comma-separated keys of at least 32 characters; clients send `Authorization: Bearer <key>`). The database in the compose file trusts connections inside the compose network and publishes no port; do not reuse that file as is outside a demo.

The image is built from the repository root (`docker build -f apps/server/Dockerfile -t nestrix-server .`); it runs as the unprivileged `node` user and exposes 4318. `docker compose down -v` removes the stack and its data.

End-to-end check (builds the image, runs two example services against it): `NESTRIX_E2E_DOCKER=1 pnpm exec vitest run --project @nestrix/server test/e2e`.
