# @nestrix-js/server

The standalone Nestrix server. One process, one port (default `4318`), backed by PostgreSQL 18:

| Path | What |
|---|---|
| `POST /v1/traces` | OTLP/HTTP receiver (protobuf or JSON, optional gzip) |
| `GET /api/v1/*` | Query API, the same shapes as the embedded dashboard, plus alert rules |
| `/` | The dashboard (the `@nestrix-js/ui` build) |
| `/login`, `/logout` | Admin sign-in |

Use it when you want history beyond one process's memory, several services in one place, or a dashboard that is not inside your app. It is private (not on npm) and distributed as a Docker image on GHCR (`linux/amd64` and `linux/arm64`, with build provenance and an SBOM). Pre-release: tags are `<version>` (for example `0.1.0-alpha.0`) and `alpha`, the latest prerelease; `latest` appears with the first stable release.

## Run with Docker

Without cloning the repository:

```bash
docker pull ghcr.io/nestrix-js/nestrix-server:alpha
docker run -p 4318:4318 -e DATABASE_URL=postgres://… -e NESTRIX_INGEST_KEYS=… -e NESTRIX_ADMIN_PASSWORD=… ghcr.io/nestrix-js/nestrix-server:alpha
```

`examples/standalone/` has a compose file with PostgreSQL, this image and two services (one with two replicas), and a snippet for adding the server to an existing compose project.

### Several services and replicas

Point every service at the server with `OTEL_EXPORTER_OTLP_ENDPOINT` (and the ingest key in `OTEL_EXPORTER_OTLP_HEADERS`). Services are grouped by `service.name`, so replicas of one service show up as one service. Nestrix gives each process a random `service.instance.id` resource attribute, visible in the trace's resource; set it yourself (for example `OTEL_RESOURCE_ATTRIBUTES=service.instance.id=$HOSTNAME`) for stable names.

### Build from source

`docker-compose.yml` in this directory builds the image and starts it with PostgreSQL 18:

```bash
cd apps/server
cp example.env .env        # then set NESTRIX_ADMIN_PASSWORD (at least 12 characters)
docker compose up --build
```

The dashboard is at <http://localhost:4318>; sign in at `/login` with the admin password. `docker compose down -v` removes the stack and its data.

**The compose file is a demo.** It sets `NESTRIX_INGEST_AUTH=none`, so any client that can reach the port may send spans without a key, and its database trusts connections inside the compose network (no password; no published port). For anything shared, remove the opt-out, set `NESTRIX_INGEST_KEYS` and give the database a password.

To build the image alone (from the repository root; it runs as the unprivileged `node` user and exposes 4318):

```bash
docker build -f apps/server/Dockerfile -t nestrix-server .
docker run -p 4318:4318 -e DATABASE_URL=postgres://… -e NESTRIX_INGEST_KEYS=… -e NESTRIX_ADMIN_PASSWORD=… nestrix-server
```

The image's health check requests `/login` and passes for any status below 500.

## Point your apps at it

Set the standard OpenTelemetry variables in each service. With a Nestrix-instrumented Nest app or any OTLP/HTTP trace exporter:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://nestrix.internal:4318
# when ingest keys are set:
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <one of NESTRIX_INGEST_KEYS>
```

The key may instead be sent as `x-nestrix-key: <key>`. Keys are compared in constant time. With neither `NESTRIX_INGEST_KEYS` nor `NESTRIX_INGEST_AUTH=none`, ingest answers 401 to everything and a start-up log line says how to configure it.

**`/v1/traces` and `/v1/logs` are accepted.** Logs are kept only as context for a trace: a log record that carries a trace id is stored next to its trace (at most 200 per trace) and shown in the trace view; a record without one is accepted and discarded. The server is not a log backend (no log search) and has no metrics receiver: send metrics, and logs you want to keep or search, to an OpenTelemetry Collector (see "Traces and trace logs only" below).

## Configuration

Read once from the environment at start and validated. A bad value exits with one message listing every problem; secret values are never echoed.

| Variable | Default | Validation and meaning |
|---|---|---|
| `DATABASE_URL` | required | A `postgres://` or `postgresql://` URL. |
| `PORT` | `4318` | Whole number, 1 to 65535. |
| `NESTRIX_INGEST_KEYS` | none | Comma-separated keys, each at least 32 characters. |
| `NESTRIX_INGEST_AUTH` | unset | Only `none` is accepted: an explicit opt-out of ingest authentication, logged as a warning on every start. Setting it together with `NESTRIX_INGEST_KEYS` is an error. |
| `NESTRIX_ADMIN_PASSWORD` | none | At least 12 characters. Without it the UI, `/login` and the query API answer 503 and a log line says why; ingest still works. |
| `NESTRIX_SESSION_SECRET` | random per start | At least 32 characters. Part of the session signing key; see "Admin login" for what it does and does not do. |
| `NESTRIX_RETENTION_DAYS` | `7` | Whole number, 1 to 3650. |
| `NESTRIX_MAX_CONNECTIONS` | `1024` | Whole number, 1 to 1 000 000. Node's `server.maxConnections`. |
| `NESTRIX_WEBHOOK_ALLOWED_HOSTS` | empty | Comma-separated host names or IP addresses (no scheme, port or path) that alert webhooks may reach although they resolve to private addresses. |
| `NESTRIX_PUBLIC_URL` | unset | `http://` or `https://` address of the dashboard, without credentials, query or fragment. Put in alert notifications as a link. |

Not configurable by environment: the ingest limits and rate limit below, and the HTTP timeouts (`requestTimeout` 60 s, `headersTimeout` 20 s).

## Admin login

- `POST /login` checks the password in constant time and sets an `HttpOnly`, `SameSite=Strict` cookie, valid for 8 hours from sign-in (absolute, not extended). The cookie is `Secure` unless the request is plain HTTP to a loopback host.
- **A restart signs everyone out**, even with a fixed `NESTRIX_SESSION_SECRET`, because sign-out revocations are held in memory and a per-process random value is part of the signing key. Changing the admin password also ends every session. Plan on signing in again after an upgrade.
- The cookie name includes the port (`nestrix_admin_<port>`), because browsers share cookies across ports on one host.
- Rate limits: 5 login attempts per minute per client address (IPv6 by /64), counted on every attempt, and a global budget of 60 failed logins a minute across all clients; once it is spent every `POST /login` answers 429 until the oldest failure leaves the minute.
- Every request except `/v1/traces`, `/v1/logs`, `/login` and `/logout` needs a session, including paths added later; the query API's read routes also accept an API token (below). A state-changing request needs a same-origin `Origin` header. The API never emits CORS headers, so a browser page on another origin cannot read it.
- **Behind a reverse proxy:** pass the `Host` header through (`proxy_set_header Host $host;` in nginx), or the `Origin` check fails and login answers 403. Serve it over HTTPS: on a non-loopback host the cookie is `Secure`, so a browser will not send it over plain HTTP. The limiter keys on the connection's address and never trusts `X-Forwarded-For`, so behind a proxy all visitors share one login limit.

## API tokens

Read-only, revocable tokens let tools such as the Nestrix MCP server (`@nestrix-js/mcp`) read the query API without a browser session.

- **Create, list and revoke** them on the dashboard's **Settings** page, or with the API from a signed-in session: `POST /api/v1/tokens` with `{"name": "..."}` (answers the token once), `GET /api/v1/tokens` (names, display prefixes, created and last-used times; no secrets), `DELETE /api/v1/tokens/:id` (revoke). A token can never manage tokens. Writes need a same-origin `Origin`, like every write.
- A token looks like `nxt_` followed by 43 characters. The server stores only its SHA-256 hash and its first 8 characters for display, so a lost token cannot be shown again: revoke it and create another. At most 100 tokens can be active.
- **Use:** `Authorization: Bearer nxt_...`. Never in a query string or a cookie; those are ignored.
- **What a token reads:** `GET` and `HEAD` on every read route of the query API: `/api/v1/meta`, `/api/v1/traces` (and `/traces/timeline`), `/api/v1/trace` (and `/trace/logs`), `/api/v1/errors` (and `/errors/groups`), `/api/v1/routes` (and `/routes/histogram`, `/routes/compare`), `/api/v1/classes`, `/api/v1/queries`, `/api/v1/map` and `/api/v1/dependencies`. Nothing else: a request with a token on the dashboard, `/login`, `/logout`, the token routes, alerts or SLOs (reads included: alert rules hold webhook URLs) or any write answers 401, even if it also carries a session cookie. The ingest routes `/v1/traces` and `/v1/logs` take only ingest keys; an API token is not an ingest key and an ingest key is not an API token.
- **Revocation is immediate:** every request looks the token up in the database, so the next request after a revoke is refused.
- **Failures share the login's budget, within a per-client allowance:** a refused token counts toward the global budget of 60 failed logins a minute, but each client (by socket address) may count only 5 refused tokens a minute; beyond that its bad tokens answer 429 with `Retry-After` and are not counted. While the global budget is spent, further bad tokens answer 429 too, as `POST /login` does. A valid token is checked first and is never refused by either limit, so one client guessing tokens cannot lock out the others' tokens.
- Tokens work only while `NESTRIX_ADMIN_PASSWORD` is set (otherwise the API answers 503). `last_used_at` is updated at most once a minute. Tokens are never logged.
- Only send tokens over HTTPS: on plain HTTP they cross the network in clear text.

```bash
curl -H "Authorization: Bearer $NESTRIX_TOKEN" https://nestrix.example.com/api/v1/routes
```

## Ingest

`POST /v1/traces` and `POST /v1/logs`. Accepted: `application/x-protobuf` and `application/json`, `Content-Encoding: gzip` or none. Responses use the request's content type. Spans that fail validation (bad ids, end before start, times far in the future) are rejected individually and reported through OTLP `partial_success`; so are log records (bad trace or span id, no time, a time far in the future). Both paths share the key, the limits below, the memory budget and the rate limit (one budget per key across both).

| Limit | Value |
|---|---|
| Request body | 20 MiB, applied to the compressed bytes and, separately, to the inflated size |
| Spans (or log records) per request | 100 000 |
| Protobuf submessages (or JSON objects) per request | 400 000 |
| JSON values (`{`, `[`, `,`) per request | 1 200 000 |
| Memory for requests in flight, whole server | 320 MiB |
| Rate limit | 100 requests per second per key, burst 200 (per client address with `NESTRIX_INGEST_AUTH=none`) |

What the answers mean:

| Status | Meaning | Client should |
|---|---|---|
| 400 | Malformed body, bad gzip, or invalid UTF-8 | Not retry. |
| 401 | Missing or wrong key, or auth not configured | Fix the key. |
| 413 | Body or inflated body over 20 MiB, or over a count cap, or a request too large for the memory budget | Send smaller batches; do not retry as is. |
| 415 | Unsupported `Content-Type` or `Content-Encoding` | Send protobuf or JSON, gzip or none. |
| 429 | Over the rate limit; has `Retry-After` | Retry after that many seconds. |
| 503 | Memory budget full (`Retry-After: 1`), the write queue is full, or the database is unavailable (`Retry-After: 5`) | Retry; OTLP exporters do. |

The 20 MiB limit matches the OpenTelemetry Collector's OTLP receiver. A batch of 2 048 spans, as the SDK's batch processor sends them, is far below every cap.

### Traces and trace logs only

Log records sent to `/v1/logs` are kept only when they carry a trace id, in the `logs` table: time, severity, the body as text (cut to 8,192 characters), the `nestrix.log.context` attribute, the span id and the resource's `service.name`. Other attributes are not stored. At most 200 lines are kept per trace (later ones are dropped), and they are partitioned by day and removed by the same retention as spans. The trace view lists them next to the waterfall (`GET /api/v1/trace/logs?id=`). A Nestrix app sends them with `logs.export` (and `NestrixLogger`) and the same endpoint as its traces:

```ts
NestrixModule.forRoot({ logs: { export: true } }) // OTEL_EXPORTER_OTLP_ENDPOINT=http://nestrix.internal:4318
```

There is no `/v1/metrics`. A request to it is not an ingest request: the admin layer answers it (403 for a `POST` without a same-origin `Origin` header, which OTLP exporters do not send; 503 when no admin password is set). Exporters treat both as failures and may retry. A Nestrix app that exports metrics to the same base endpoint will log these errors; point metrics at a collector (`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`) or turn them off.

## The measured envelope

Preliminary, from one run (`benchmarks/results/server-ingest.md`): on a laptop (Apple silicon, Docker in a VM with 7.7 GiB, load generator, server and Postgres on the same host, default Postgres settings), the server accepted and stored **about 20 000 spans per second** for 45 seconds with nothing refused, and about 22 000 spans per second when offered 80 000, refusing the rest with back-pressure rather than growing memory. Every accepted span was stored. The server process used 250 to 310 MiB.

**This is not a guarantee.** The paced run met its target, so 20 000 is a lower bound for that machine, not a ceiling; a different machine, network, span size or concurrent dashboard use will differ. The full benchmark is deferred. Beyond what you measure on your own hardware, send OTLP to a dedicated backend.

## Retention and partitions

`spans`, `traces`, the per-minute rollups and the trace logs (`logs`) are partitioned by UTC day. At start and then every hour the server creates partitions for today and the next two days and drops partitions older than `NESTRIX_RETENTION_DAYS`. With 7 and today 2026-11-11, 2026-11-04 is the oldest day kept: at least 7 days of data, up to nearly 8. Retention is by dropping partitions, so it is instant and leaves no dead rows. Per-route and per-class statistics are rolled up per minute at ingest; a retried export is not counted twice. Class counts are post-sampling, because the server sees only what services chose to export.

## Alerting

Alert rules are managed through the API (`/api/v1/alerts`, admin session required); the dashboard has no alerts page yet. A rule watches one service, optionally one route, over a window of 5 to 60 minutes:

- `metric`: `error_rate` (a fraction; 0.05 is 5%), `p95_ms`, or `slo_burn_rate` (give `sloId`; the rule takes its service and route from that [SLO](#slos) and fires when the SLO's burn rate over the rule's window is above `threshold`), compared with `>` to a `threshold`.
- `forMinutes` (0 to 60, default 2): how long the condition must hold before the alert fires.
- `minRequests` (default 10): fewer requests in the window is "no data", which changes nothing, so a dead service does not resolve a firing alert.
- States: `ok`, `pending`, `firing`. A notification is sent when a rule starts firing and when it resolves. Rules are evaluated every 60 seconds by one instance at a time.

Create a rule (sign in first, send `Origin` for a state-changing call):

```bash
curl -X POST https://nestrix.example.com/api/v1/alerts \
  -H 'Origin: https://nestrix.example.com' -b cookies.txt \
  -H 'content-type: application/json' \
  -d '{"name":"checkout errors","service":"checkout","metric":"error_rate","threshold":0.05,"windowMinutes":5,"webhookUrl":"https://hooks.example.com/nestrix"}'
```

The response includes the signing `secret` (`whsec_…`) **once**; store it. `POST /api/v1/alerts/:id/test` sends a test notification, and `GET /api/v1/alerts/events` lists deliveries.

**Webhooks.** The server sends a `POST` with a JSON body (state `firing`, `resolved` or `test`, the rule, value, threshold, service, route, times and a dashboard `url` when `NESTRIX_PUBLIC_URL` is set) and two headers: `x-nestrix-timestamp` (Unix seconds) and `x-nestrix-signature: sha256=<hex>`, the HMAC-SHA256 of `<timestamp>.<raw body>` with the rule's secret. Each attempt has a 5 s limit; up to 3 attempts, retried on network errors, timeouts, 408, 429 and 5xx; redirects are never followed. Delivery is at most once across a server crash. Every notification has an `eventId` (also the `x-nestrix-delivery` header), the same on every retry of that notification. A receiver should:

- **dedupe on `eventId`**: a retry after a slow or lost answer delivers the same event again, and a receiver that pages someone must not page twice;
- **order by `sentAt`, not by arrival**: retries and parallel deliveries can arrive out of order, so a late `firing` must not overwrite a newer `resolved`;
- **check the timestamp** is within 5 minutes of now, to reject replays;
- **verify the signature over the raw body** (not a re-serialised parse), comparing with `crypto.timingSafeEqual`.

The example below does the timestamp and signature checks (`test/alerts/webhook.test.ts` runs this exact code against a real delivery):

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, headers, rawBody) {
  const timestamp = headers["x-nestrix-timestamp"];
  const signature = headers["x-nestrix-signature"];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false; // replay window
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

**Private addresses are refused.** The server resolves the webhook host and refuses the delivery if any address is loopback, private, link-local or otherwise not public (this also covers IPv4 addresses embedded in IPv6). To send to an internal receiver, list its host name in `NESTRIX_WEBHOOK_ALLOWED_HOSTS` (exact host names or IP addresses, no ports). Only hosts you trust belong there, because the check is the protection against a rule being used to reach internal services. Alert events are deleted after `NESTRIX_RETENTION_DAYS`.

## SLOs

Service level objectives are managed on the dashboard's **SLOs** page or through the API (`/api/v1/slos`: `GET`, `POST`, `GET/PATCH/DELETE /:id`; admin session required, a write needs a same-origin `Origin`; an API token cannot reach them). An SLO watches one service, optionally one route:

- `kind`: `availability` (the share of requests that are not errors) or `latency` (the share faster than `latencyThresholdMs`, up to one hour).
- `objective`: the target share of good requests, strictly between 0 and 1 (`0.999`); `windowDays`: 7 or 30.
- Its status, computed from the per-minute rollups (so counted at the server, after the services' own sampling): attainment, the error budget (allowed, remaining requests, remaining fraction), burn rates over the last 1 and 6 hours, and whether it is breached. A 30-day SLO reads up to 43,200 minute rows per query.
- An alert rule with `metric: "slo_burn_rate"` takes its service and route from an SLO and fires on its burn rate (see Alerting).

## Upgrading

Pull or rebuild the image and restart. Migrations are applied at start, in order, under a PostgreSQL advisory lock, so several instances starting together are safe; each runs in a transaction, and a migration file changed after it was applied stops the start. There is no downgrade: back up the database before upgrading. A restart signs every admin out (see "Admin login").

## Security notes

- **The ingest port is the admin port.** Ingest, the login form, the dashboard and the API all share one port, so exposing it to your services exposes `/login` to them too. Login is rate limited and the password needs 12 characters, but put the server behind a TLS-terminating proxy and, where you can, restrict who can reach it.
- Without TLS, ingest keys, API tokens and the admin password cross the network in clear text.
- `NESTRIX_INGEST_AUTH=none` is for local demos. Anyone who can reach the port can write spans.
- The server stores the span attributes services send it; it does not scrub them. Redaction happens in each service's `@nestrix-js/nestjs` configuration before export.
- The alert signing secret is stored in clear in the database, because the server signs with it. Protect the database.

## Checks

End-to-end test (builds the image, runs two example services against it): `NESTRIX_E2E_DOCKER=1 pnpm exec vitest run --project @nestrix-js/server test/e2e`.
