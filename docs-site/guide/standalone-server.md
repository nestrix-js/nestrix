# Standalone server

`@nestrix-js/server` is a separate process that receives OTLP/HTTP traces from one or more services, stores them in PostgreSQL 18 and serves the same dashboard. Use it when you want history beyond one process's memory, several services in one place, or a dashboard that is not inside your app.

::: warning Status
The server is built and tested in the repository. It is private (not on npm). The Docker image is published to GHCR by the release workflow (`linux/amd64` and `linux/arm64`, with provenance and an SBOM), tagged `<version>` (for example `0.1.0`) and `latest`.
:::

## Run it

Without cloning the repository:

```bash
docker pull ghcr.io/nestrix-js/nestrix-server:latest
```

`examples/standalone/` in the repository has a compose file with PostgreSQL, this image and two services (one running two replicas), and a snippet for adding the server to an existing compose project.

## Several services and replicas

Every service sends to the server with `OTEL_EXPORTER_OTLP_ENDPOINT` (and the ingest key in `OTEL_EXPORTER_OTLP_HEADERS`). The server groups by `service.name`, so replicas of one service are one service in the list and the map. Nestrix gives each process a random `service.instance.id` resource attribute, shown in a trace's resource; set it yourself for stable names, for example `OTEL_RESOURCE_ATTRIBUTES=service.instance.id=$HOSTNAME`.

## Build and run from source

The compose file in `apps/server` builds the image and starts PostgreSQL 18 and the server on `http://localhost:4318`:

```bash
cd apps/server
cp example.env .env        # then set NESTRIX_ADMIN_PASSWORD (at least 12 characters)
docker compose up --build
```

The compose file sets `NESTRIX_INGEST_AUTH=none`, so any client that can reach the port can send spans without a key. That is for a local demo only; for anything shared, set `NESTRIX_INGEST_KEYS` instead and give the database a password. To build the image alone, run `docker build -f apps/server/Dockerfile -t nestrix-server .` from the repository root. Without Docker, with a PostgreSQL 18 database available and the variables below set:

```bash
pnpm install
pnpm --filter @nestrix-js/server build
pnpm --filter @nestrix-js/server start
```

The server listens on one port (default `4318`):

| Path | What |
|---|---|
| `POST /v1/traces` | OTLP/HTTP trace receiver (ingest key) |
| `POST /v1/logs` | OTLP/HTTP log receiver: records with a trace id are kept next to the trace (ingest key) |
| `GET /api/v1/*` | Query API, same shapes as the embedded dashboard (`meta`, `traces`, `traces/timeline`, `trace`, `trace/logs`, `errors`, `errors/groups`, `routes`, `routes/histogram`, `routes/compare`, `classes`, `queries`, `map`, `dependencies`, `overview`, `instances`, `remote-profiles`); session or API token |
| `POST /v1/nestrix/check-in`, `POST /v1/nestrix/profiles/:id` (and `/failed`) | [Remote CPU profiling](#remote-cpu-profiling), instance side (ingest key) |
| `POST /api/v1/remote-profiles` | Start a remote capture (admin session only) |
| `/api/v1/tokens` | Create, list and revoke API tokens (session only) |
| `/api/v1/alerts`, `/api/v1/slos` | Alert rules and SLOs (session only) |
| `/` | The dashboard (from `@nestrix-js/ui`) |
| `/login`, `/logout` | Admin sign-in |

Point each service at it with `OTEL_EXPORTER_OTLP_ENDPOINT` set to the server's address (for example `http://nestrix:4318`). When ingest keys are set, services also send a key in the `Authorization` header: use `OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <key>` or `export.otlp.headers` in the module options.

Traces and logs are accepted: set `logs: { export: true }` in the module options and the same endpoint receives the app's `NestrixLogger` records. Only records that carry a trace id are kept ([as context for the trace](/guide/dashboard#logs-next-to-the-trace): at most 200 per trace, body cut to 8,192 characters, partitioned by day and dropped with the spans). There is no `/v1/metrics`: send metrics to an OpenTelemetry Collector or a metrics backend (an app exporting them to the server gets errors back), and use a log backend for logs you want to search.

## Configuration

The server reads its configuration from the environment at start and validates it. A bad value exits with a message listing every problem, never echoing a secret.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | `postgres://` or `postgresql://` URL. |
| `PORT` | `4318` | 1 to 65535. |
| `NESTRIX_INGEST_KEYS` | none | Comma-separated ingest keys, each at least 32 characters. |
| `NESTRIX_INGEST_AUTH` | unset | Only `none` is accepted: an explicit opt-out of ingest authentication for local demos, logged as a warning on every start. Setting it together with `NESTRIX_INGEST_KEYS` is an error. |
| `NESTRIX_ADMIN_PASSWORD` | none | At least 12 characters. Without it the UI and query API answer 503 and a log line says why; ingest still works. |
| `NESTRIX_SESSION_SECRET` | random per start | At least 32 characters. Part of the session signing key. Sessions end at every restart either way. |
| `NESTRIX_RETENTION_DAYS` | `7` | 1 to 3650. Daily partitions older than this are dropped. |
| `NESTRIX_MAX_CONNECTIONS` | `1024` | Node's `server.maxConnections`. |
| `NESTRIX_WEBHOOK_ALLOWED_HOSTS` | empty | Comma-separated hosts that alert webhooks may reach although they resolve to private addresses. |
| `NESTRIX_PUBLIC_URL` | unset | The dashboard's `http(s)` address, used for links in alert notifications. |

## Ingest authentication

A sender passes a key as a bearer token in the `Authorization` header, or in the `x-nestrix-key` header. Keys are compared in constant time. With neither `NESTRIX_INGEST_KEYS` nor `NESTRIX_INGEST_AUTH=none`, ingest answers 401 and a start-up log line says how to configure it.

The receiver accepts `application/x-protobuf` and `application/json`, with optional gzip. Limits: 20 MiB per request (compressed and decompressed), caps on spans and objects per request, a process-wide memory budget for requests in flight (503 with `Retry-After` when full), and a per-key rate limit of 100 requests per second with a burst of 200 (429 with `Retry-After`). A malformed body is 400. Spans that fail validation are rejected individually and reported through OTLP `partial_success`. When the database is down, ingest answers 503 so the exporter retries.

## Login

`/login` serves a small form. `POST /login` checks the password in constant time, is limited to 5 attempts per minute per client address, and requires a same-origin `Origin` header. It sets an `HttpOnly`, `SameSite=Strict` session cookie (8 hours, `Secure` unless the request is plain HTTP to a loopback host) signed with HMAC. Changing the admin password ends every session, and so does restarting the server. Everything except `/v1/traces`, `/v1/logs`, `/login` and `/logout` needs a session, including paths added later (the query API's read routes also accept an [API token](#api-tokens)), and the API never emits CORS headers.

Behind a reverse proxy, pass the `Host` header through or the `Origin` check fails. All visitors then share the proxy's login rate limit.

## API tokens

For tools that read the server without a browser, such as the Nestrix MCP server, create a read-only API token on the dashboard's **Settings** page (or `POST /api/v1/tokens` with `{"name": "..."}` from a signed-in session). The token, `nxt_` followed by 43 characters, is shown once; the server keeps only its SHA-256 hash. Send it as `Authorization: Bearer nxt_...`:

```bash
curl -H "Authorization: Bearer $NESTRIX_TOKEN" https://nestrix.example.com/api/v1/traces?limit=10
```

A token reads `GET`/`HEAD` on every route of the query API (`/api/v1/meta`, `traces`, `traces/timeline`, `trace`, `trace/logs`, `errors`, `errors/groups`, `routes`, `routes/histogram`, `routes/compare`, `classes`, `queries`, `map`, `dependencies`, `overview`, and the read routes for instances and remote profiles), and nothing else: not the dashboard, not the token, alert or SLO routes, never a write, and never ingest (ingest keys and API tokens are separate). Revoking a token on the Settings page stops it at the next request. Refused tokens count toward the login's global budget of failed attempts, within an allowance of 5 refused tokens a minute per client, so one client guessing tokens cannot lock the others out; a valid token is never refused by either limit. At most 100 tokens can be active. The [Security model](/guide/security#standalone-server-api-tokens) page has the rules.

## Retention and storage

Spans are stored in daily PostgreSQL partitions. At start and then every hour the server creates partitions for today and the next two days, and drops partitions older than `NESTRIX_RETENTION_DAYS`. Per-route and per-class statistics are rolled up per minute at ingest. A retried export is not counted twice. Class counts are post-sampling here, because the server only sees what services chose to export, and the UI says so.

## Several services

When more than one service name has been seen, the dashboard shows a service selector that filters every view, and the map draws the calls between services as well as each service's databases and external targets.

## Alerting

Alert rules (error rate, p95 or an SLO's burn rate over a window, for one service or route) are managed through `/api/v1/alerts` and notify a webhook when they fire and when they resolve. The dashboard has no alerts page yet. Webhooks are signed (`x-nestrix-signature`, HMAC-SHA256 of the timestamp and body) and refused when the host resolves to a private address, unless it is in `NESTRIX_WEBHOOK_ALLOWED_HOSTS`. The server's README has the rule fields and a verification example.

## SLOs

The **SLOs** page lists availability and latency objectives per service or route, over 7 or 30 days, with attainment, error budget and 1 h and 6 h burn rates. You create, edit and delete them on the page (or through `/api/v1/slos`), and they can drive an alert rule with the `slo_burn_rate` metric. Like the route statistics they are computed from the minute rollups, so they reflect what services chose to export.

## Remote CPU profiling

The server can take a CPU profile of one instance of an app, from the **Profiler** tab. The server never connects to an instance: an app that opts in checks in with the server and picks up a capture order there, so it works behind load balancers and NAT.

```ts
NestrixModule.forRoot({
  export: {
    profiler: true,
    otlp: { endpoint: "http://nestrix.internal:4318", headers: { authorization: "Bearer <ingest key>" } },
  },
})
```

How it works:

1. Each instance sends a check-in (`POST /v1/nestrix/check-in`, with the ingest key) a few seconds after it starts and then every 15 seconds, with its service name, instance id, version, host name, pid and Node.js version. The Profiler tab lists the instances seen in the last 2 minutes.
2. An admin picks an instance and a duration (15 to 120 seconds in the page, 1 to 120 in the API) and starts a capture. It waits as `pending`, so it begins at the instance's next check-in, up to 15 seconds later.
3. The instance captures with the same limits as the [embedded profiler](/guide/dashboard#profiler) (one capture per process, a 10-second cool-down) and uploads the gzipped `.cpuprofile`, or reports why it could not. The tab then shows a flame graph, the top functions and a download for Chrome DevTools or speedscope.
4. A capture not picked up within 60 seconds, or not uploaded within its duration plus 60 seconds, becomes `expired`. The newest 20 finished captures per service are kept, within the retention period.

Security notes:

- **Off by default.** Starting a capture pauses the instance's main thread briefly (tens of milliseconds, more with a lot of compiled code), so nobody can do it to an app that has not set `export.profiler: true`.
- **Admin session only.** An API token cannot start a capture, as tokens are read-only. The start needs the same same-origin checks as the embedded one (`Sec-Fetch-Site: same-origin` and a same-origin `Origin`), so a browser sends it only over HTTPS or to localhost.
- **The key goes only to the export endpoint.** Check-ins carry the same headers as the trace export. When the endpoint comes from `OTEL_EXPORTER_OTLP_ENDPOINT`, only `OTEL_EXPORTER_OTLP_HEADERS` and `export.otlp.headers` are sent, never `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, because that variable belongs to the traces URL, which may be a different host. To check in with your server while a Collector is the generic endpoint, set `export.otlp.endpoint`. Redirects are not followed.
- **An instance is owned by the key that first checked in.** Another key cannot check in for the same instance id, and only the key that received an order can upload or fail it. Uploads are checked field by field, and only `.cpuprofile` fields are stored.
- **A non-Nestrix endpoint** (a Collector, Jaeger) answers 404 to the check-in: the app logs one line and stops polling until it restarts. The check-in requests are not traced.

The [server README](https://github.com/nestrix-js/nestrix/blob/main/apps/server/README.md#remote-cpu-profiling) has the request and response details.

## Settings

The **Settings** page creates, lists and revokes the read-only [API tokens](#api-tokens). It exists only in the standalone server.

## Capacity

One preliminary run on a laptop ingested about 20 000 spans per second with nothing refused. It is a measurement, not a guarantee; the full benchmark is deferred. Past what you measure on your hardware, send OTLP to a dedicated backend.

## Upgrading

Migrations run at start under an advisory lock. Back up the database before upgrading; there is no downgrade.
