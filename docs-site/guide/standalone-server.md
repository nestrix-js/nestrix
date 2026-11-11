# Standalone server

`@nestrix/server` is a separate process that receives OTLP/HTTP traces from one or more services, stores them in PostgreSQL 18 and serves the same dashboard. Use it when you want history beyond one process's memory, several services in one place, or a dashboard that is not inside your app.

::: warning Status
The server is built and tested in the repository, but it is private and not yet distributed. The Docker image and compose file are task P5-06 and are not in the repository yet, so this page shows how to run it from a checkout and what the image will take as configuration. Update this page when the image exists.
:::

## Run it

From a checkout of the repository, with a PostgreSQL 18 database available, set the variables in the table below and start the server:

```bash
pnpm install
pnpm --filter @nestrix/server build
pnpm --filter @nestrix/server start
```

The server listens on one port (default `4318`):

| Path | What |
|---|---|
| `POST /v1/traces` | OTLP/HTTP receiver |
| `GET /api/v1/*` | Query API, same shapes as the embedded dashboard |
| `/` | The dashboard (from `@nestrix/ui`) |
| `/login`, `/logout` | Admin sign-in |

Point each service at it with `OTEL_EXPORTER_OTLP_ENDPOINT` set to the server's address (for example `http://nestrix:4318`). When ingest keys are set, services also send a key in the `Authorization` header: use `OTEL_EXPORTER_OTLP_HEADERS` or `export.otlp.headers` in the module options.

## Configuration

The server reads its configuration from the environment at start and validates it. A bad value exits with a message listing every problem, never echoing a secret.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | `postgres://` or `postgresql://` URL. |
| `PORT` | `4318` | 1 to 65535. |
| `NESTRIX_INGEST_KEYS` | none | Comma-separated ingest keys, each at least 32 characters. |
| `NESTRIX_INGEST_AUTH` | unset | Only `none` is accepted: an explicit opt-out of ingest authentication for local demos, logged as a warning on every start. Setting it together with `NESTRIX_INGEST_KEYS` is an error. |
| `NESTRIX_ADMIN_PASSWORD` | none | At least 12 characters. Without it the UI and query API answer 503 and a log line says why; ingest still works. |
| `NESTRIX_SESSION_SECRET` | random per start | At least 32 characters. Set it so sessions survive a restart. |
| `NESTRIX_RETENTION_DAYS` | `7` | 1 to 3650. Daily partitions older than this are dropped. |
| `NESTRIX_MAX_CONNECTIONS` | `1024` | Node's `server.maxConnections`. |

## Ingest authentication

A sender passes a key as a bearer token in the `Authorization` header, or in the `x-nestrix-key` header. Keys are compared in constant time. With neither `NESTRIX_INGEST_KEYS` nor `NESTRIX_INGEST_AUTH=none`, ingest answers 401 and a start-up log line says how to configure it.

The receiver accepts `application/x-protobuf` and `application/json`, with optional gzip. Limits: 20 MiB per request (compressed and decompressed), caps on spans and objects per request, a process-wide memory budget for requests in flight (503 with `Retry-After` when full), and a per-key rate limit of 100 requests per second with a burst of 200 (429 with `Retry-After`). A malformed body is 400. Spans that fail validation are rejected individually and reported through OTLP `partial_success`. When the database is down, ingest answers 503 so the exporter retries.

## Login

`/login` serves a small form. `POST /login` checks the password in constant time, is limited to 5 attempts per minute per client address, and requires a same-origin `Origin` header. It sets an `HttpOnly`, `SameSite=Strict` session cookie (8 hours, `Secure` unless the request is plain HTTP to a loopback host) signed with HMAC. Changing the admin password ends every session. Everything except `/v1/traces`, `/login` and `/logout` needs a session, including paths added later, and the API never emits CORS headers.

Behind a reverse proxy, pass the `Host` header through or the `Origin` check fails. All visitors then share the proxy's login rate limit.

## Retention and storage

Spans are stored in daily PostgreSQL partitions. At start and daily the server creates partitions for today and the next two days, and drops partitions older than `NESTRIX_RETENTION_DAYS`. Per-route and per-class statistics are rolled up per minute at ingest. A retried export is not counted twice. Class counts are post-sampling here, because the server only sees what services chose to export, and the UI says so.

## Several services

When more than one service name has been seen, the dashboard shows a service selector that filters every view, and the map draws the calls between services as well as each service's databases and external targets.
