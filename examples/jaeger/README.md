# Jaeger example: two services, one trace

Two NestJS 12 apps, both with `NestrixModule.forRoot({ serviceName })`, exporting OTLP/HTTP to Jaeger.

- `service-a` (port 3001): `GET /call/:id` fetches `service-b`'s `GET /items/:id`.
- `service-b` (port 3002): answers JSON.
- `docker-compose.yml`: Jaeger v2 all-in-one (`jaegertracing/jaeger`, tag pinned), UI on 16686, OTLP/HTTP on 4318.

Nestrix has no endpoint option set in the code; export is switched on by `OTEL_EXPORTER_OTLP_ENDPOINT`.

## Run by hand

```bash
pnpm build
docker compose -f examples/jaeger/docker-compose.yml up -d
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
pnpm --filter jaeger-example start:b &
pnpm --filter jaeger-example start:a &
curl localhost:3001/call/42
# UI: http://localhost:16686 (spans are exported every 5 s)
```

## The check

```bash
pnpm build
pnpm --filter jaeger-example check            # starts and stops Jaeger itself
node examples/jaeger/scripts/check-trace.mjs --no-compose   # Jaeger already running
```

`scripts/check-trace.mjs` starts both apps on free ports, sends one request to service A, and polls Jaeger's api_v3
(`GET /api/v3/traces`; Jaeger v2 no longer serves `/api/traces`) until one trace holds:

1. service-a server span `GET /call/:id`,
2. a service-a client span whose parent is that server span,
3. service-b server span `GET /items/:id` whose parent is that client span.

On timeout it prints which services Jaeger knows, what the best trace contains and what is missing, then exits 1.
Environment overrides: `JAEGER_QUERY_URL`, `OTLP_URL`, `CHECK_TIMEOUT_MS`.

The check needs the server spans (P1-06) and outbound `fetch` client spans (P1-09). `ci-job.yml` is the job
definition to merge into `.github/workflows/ci.yml`.
