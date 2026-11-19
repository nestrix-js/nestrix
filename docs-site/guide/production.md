# Running the standalone server in production

This page is for the person who has to decide how big the [standalone server](/guide/standalone-server) and its PostgreSQL must be, and how to keep them running. Every number is marked **measured** (with the shape of the test), **from the code** (a limit or default you can read in `apps/server`) or **estimate** (my arithmetic or a starting point, not tested). Measured numbers come from one laptop and a synthetic load; check them on your own data with the scripts named below.

Ready-made deployments: a [Docker Swarm stack](https://github.com/nestrix-js/nestrix/tree/main/deploy/swarm) and a [Helm chart](https://github.com/nestrix-js/nestrix/tree/main/deploy/helm/nestrix-server). Both follow this page.

## Pinned images

`:latest` moves. Pin the version **and** the digest, so a re-pushed tag cannot change what runs:

```yaml
image: ghcr.io/nestrix-js/nestrix-server:0.6.0@sha256:c9fb43475334430c5bdd30e9302a9009abe12951932380c3951a6483d96822f6
```

To read the digest of a release (the digest of the multi-architecture index is the one to pin):

```bash
docker buildx imagetools inspect ghcr.io/nestrix-js/nestrix-server:0.6.0
# Digest: sha256:c9fb4347…
```

`0.6.0` and its digest are what `:latest` pointed to on 2026-11-18. When you move to a newer release, change the tag and the digest together; the [release notes](https://github.com/nestrix-js/nestrix/releases) say whether it needs anything beyond a restart (see [Upgrades](#upgrades)). Pin PostgreSQL and the proxy the same way; the stack and the chart do.

## Sizing

### CPU and memory

Measured on 2026-11-18, one Apple-silicon laptop, Docker in a VM, load generator, server and PostgreSQL on the same host, `apps/server/scripts/ingest-load.mjs` (3-span traces through the official OTLP exporter), 20 s runs, `docker stats` sampled a few times per run, so the CPU figures are rough:

| Ingest rate | Server CPU (share of one core) | Server memory | PostgreSQL CPU (share of one core) |
|---|---|---|---|
| 5 000 spans/s | about 15% | 327 to 333 MiB | 1% to 73% (peaks follow batch commits) |
| 20 000 spans/s | 18% to 79% | 340 to 464 MiB | 2% to 73% |

The earlier preliminary run (`benchmarks/results/server-ingest.md`) saw 4% to 9% of a core and 250 to 310 MiB at 20 000 spans/s. Rule of thumb, **estimate**: **0.03 core per 1 000 spans/s** for the server, about 135 MiB resident when idle and up to about 650 MiB under heavy ingest (the 5 000 to 20 000 spans/s runs above measured 327 to 464 MiB), and PostgreSQL needing about as much CPU as the server under load. That is the whole basis of the requests and limits in the stack and the chart (0.25 core and 256 MiB requested, 1 core and 768 MiB limit per replica, roughly 10 000 spans/s across two replicas). The server accepted about 20 000 spans/s with nothing refused in the preliminary run; past what a replica takes, it answers 503 or 429 and OTLP exporters retry (back-pressure instead of growing memory; from the code, README "Ingest").

Memory for requests in flight is capped at 320 MiB for the whole server, but the process holds more than that at peak, because finished requests wait for the garbage collector. Measured with bursts of 19 MiB exports from slow clients (`benchmarks/results/ingest-memory.md`, Linux container, PostgreSQL): peak resident 632 MiB under a 768 MiB limit; at 512 MiB the server was killed for memory. Keep the limit at 768 MiB or more; do not lower it below about 650 MiB.

What the numbers leave out: dashboard queries (a heavy page on a large database costs PostgreSQL more than ingest does), traces with many more attributes, and network between the pieces.

### Storage

Run `apps/server/scripts/footprint-load.mjs` against a fresh server and read the sizes from PostgreSQL. **Measured**, on `postgres:18.6`, the pinned server image, 20 000 traces of six spans each (an HTTP server span, a guard, an interceptor, the handler, a service method, a database client span with a 70-character statement; 3 to 10 attributes per span, 5 resource attributes) and two trace log lines of about 90 characters per trace, sent as OTLP/JSON. Sizes are `pg_total_relation_size` of the daily partitions: table, indexes and TOAST.

| Table | Rows | Size | Per row |
|---|---|---|---|
| `spans` | 120 000 | 80.4 MB | 670 bytes |
| `traces` | 20 000 | 15.9 MB | 795 bytes |
| `logs` (trace logs) | 40 000 | 21.0 MB | 525 bytes |
| `route_minutes`, `class_minutes` (rollups) | one row per route or class per minute | 0.1 MB each | not per span |
| Whole database, growth over the empty one | | 117 MB | **5.9 KB per trace**, about **980 bytes per span** with its share of trace row and logs |

(The empty database is 9.6 MB.) So the shape above costs about 1 KB per span all in. Your spans will differ: more attributes, longer statements or messages, or no logs move it. Measure your own with the script, or take the formula below and a safety factor.

**Formula** (the estimate part is the safety factor):

```
disk  =  spans per second  x  86 400  x  (NESTRIX_RETENTION_DAYS + 1)  x  bytes per span  x  1.3
```

- `+ 1` because retention keeps whole UTC days: with 7 days you hold 7 to nearly 8 (README, "Retention and partitions").
- `bytes per span`: 1 000 for the shape above (measured), then your own.
- `1.3` is an **estimate**: room for write-ahead log, PostgreSQL's free space inside pages, the rollups, and a dump file next to the data if you take it on the same disk. Measured sizes came from a freshly filled database; partitions are dropped, not vacuumed, so I expect little bloat in the span tables, but I have not run a long soak.

Worked example (estimate from the formula): 200 spans/s, 7 days: `200 x 86 400 x 8 x 1 000 x 1.3` is about 180 GB. 1 000 spans/s at 7 days is about 900 GB. If that is more than you want, the lever is **head sampling in the apps** (the server stores what it receives) or fewer retention days. Retention is a whole number from 1 to 3650 (from the code).

Disk grows in daily steps and shrinks at once when a partition is dropped; PostgreSQL returns the space of a dropped partition to the file system, so the size you watch is `pg_database_size`, not what is in use inside a table.

## PostgreSQL

The server needs PostgreSQL with `CREATE`, `INSERT`, partition and advisory-lock rights on its database; the stack and the chart run `postgres:18.6` (the version the project's tests and compose file use). Settings that matter:

| Setting | Value in the stack and chart | Why |
|---|---|---|
| `max_connections` | 100 | Each server replica keeps a pool of up to 10 connections (from the code), so 2 replicas use up to 20. Leave room for `psql`, `pg_dump` and more replicas: `10 x replicas + 10` at least. |
| `shared_buffers` | 512MB | **Estimate**, a quarter of a 2 GiB limit. The hot data is the newest partitions. |
| `autovacuum_vacuum_scale_factor`, `autovacuum_analyze_scale_factor` | 0.05 | **Estimate.** The per-minute rollup tables (`route_minutes`, `class_minutes`, and the other rollups) are updated in place by every batch (`ON CONFLICT` upserts), so they are the tables that collect dead rows; the span tables are append-only and dropped by day. A smaller scale factor makes autovacuum visit the rollups sooner. The defaults (0.2 and 0.1) also work for a small install. |

Everything else can stay at the defaults.

## Backup and restore

**What to back up: the whole database.** It holds the telemetry (`spans`, `traces`, `logs`, the rollups, remote profiles) and the configuration (alert rules, SLOs, API tokens, sessions, and `nestrix_schema_migrations`, which records which migrations ran). Back up the telemetry only if you need history beyond what you would rebuild: it is bounded by retention anyway; the configuration is small and not reconstructible.

**A `pg_dump` taken while the server is ingesting restores consistently.** `pg_dump` reads one snapshot. The project's test (`apps/server/test/backup/backup.test.ts`, runs in `pnpm test` with Docker) ingests traces and logs through the real endpoints, runs `pg_dump --format=custom` while ingest keeps going, restores into a new database with `pg_restore`, and checks that no span lacks its trace row, that every trace's `span_count` equals the spans stored, that the migration record is identical, and that a second server started on the restored database returns the same trace and its logs as the original. Ingest does not have to stop.

```bash
# Backup. Use a pg_dump of the same major version as the server (or newer); a dump from an older client can refuse a newer server.
pg_dump --format=custom --no-owner -h <host> -U nestrix -d nestrix -f nestrix-$(date +%F).dump

# Restore into a new, empty database, then start the server on it. It finds every migration recorded and does nothing.
createdb -h <host> -U postgres nestrix_restored
pg_restore --exit-on-error --no-owner -h <host> -U postgres -d nestrix_restored nestrix-2026-11-18.dump
```

On Swarm and Kubernetes the commands run inside the PostgreSQL container so the versions match; the [stack README](https://github.com/nestrix-js/nestrix/tree/main/deploy/swarm#backup-and-restore) and the [chart README](https://github.com/nestrix-js/nestrix/tree/main/deploy/helm/nestrix-server#backup-and-restore) have the exact commands.

Points to know:

- After a restore, the server's hourly maintenance drops any day partition older than `NESTRIX_RETENTION_DAYS` (from the code), so restoring an old dump does not bring back data past retention for long.
- `pg_dump` of a large database takes time and I/O. Dump from a replica or outside peak hours if you have either. A physical backup (`pg_basebackup`, or your provider's snapshots with WAL archiving) also works and supports point-in-time recovery; it is not tested here.
- A dump is a copy of the secrets' effects, not of the secrets: the ingest keys, admin password and session secret are in your environment or secret store, not in the database. Back those up separately. Stored API tokens and webhook settings are in the dump.
- Keep a restore drill on your calendar. A backup that was never restored is a hope.

## Upgrades

Migrations run when a server starts, in order, under a PostgreSQL advisory lock, so replicas starting together are safe. **There is no downgrade: take a backup first.**

**Policy (expand/contract).** A migration may only add (tables, nullable or defaulted columns, indexes that old statements do not depend on) or relax a constraint. A change that removes, renames, retypes or re-keys something the previous release reads or writes is split in two: release N adds the new form and ships code that works with both, release N+1 removes the old one. The one exception is a migration listed in `apps/server/migrations/coordinated-stop.json`, which must also carry an upgrade note in its changeset and in the server README; its release says **stop all replicas first**, and you then scale to zero before deploying. CI enforces this: `scripts/check-old-writer.mjs` takes the SQL of the latest released server, runs the checks of its `INSERT` column lists and `ON CONFLICT` targets against a database migrated with the current migrations, and fails on any break that is not listed (D-109). It covers inserts and upserts, not reads, `UPDATE` or `DELETE`. **The environments release (migration `0016`) is the one listed exception:** see the next section.

Evidence for "the previous version keeps working on the new schema for one minor", **measured** on 2026-11-18: with a database migrated by the 0.6.0 image (14 migrations), the 0.5.0 image started against it, accepted 200 traces and 400 log lines, and stored them, while a 0.6.0 server ran on the same database and did the same. Only ingest was exercised, not the dashboard.

So a rolling upgrade (start the new replica, then stop an old one) is safe for a release whose notes do not say otherwise. Both the stack (`order: start-first`) and the chart (`maxUnavailable: 0`, `maxSurge: 1`) do that. Steps:

1. Read the release notes. Check for "stop all replicas first" and for the heavy migrations in the server README ("Upgrading to 0.2.0: the `spans` index", "Upgrading to the `hasErrors` filter", "Upgrading to ingest order on `spans`"): they lock tables while an index builds and have a way to pre-build it on a large database.
2. Back up (above).
3. Change the image tag and digest, deploy.
4. Check `/readyz` on the new replicas (it is 503 until every migration is applied).

Roll back by deploying the previous tag (for an additive release): that works only if the new release's migrations were additive, which is the same policy, and the old server ignores migrations it does not know. For anything else, restore the backup.

### The environments release: stop all replicas first

Migration `0016_environments.sql` replaces the primary keys of `route_minutes` and `class_minutes` with unique keys that include `environment`. A server from before this release still upserts them with the old `ON CONFLICT` columns, which PostgreSQL rejects after the migration (`there is no unique or exclusion constraint matching the ON CONFLICT specification`): an old replica still taking traffic fails its ingest transactions. A rolling update therefore must not be used for this release, whatever the chart or stack default is. Upgrade like this:

1. Back up with `pg_dump` (above). This is the only way back.
2. Scale the server to zero and wait until nothing runs: `docker compose stop`, `docker service scale nestrix_server=0` (Swarm), or `kubectl -n nestrix scale deploy/nestrix-server --replicas=0` (Helm).
3. Deploy the new tag and digest with one replica so the migration runs alone: Swarm `docker stack deploy` then `docker service scale nestrix_server=1`; Helm `helm upgrade --set replicaCount=1 ...`. With no old replica left, the chart's `RollingUpdate` strategy and the stack's `start-first` order do no harm; they are not changed. Wait for `/readyz`.
4. Scale back up (`docker service scale nestrix_server=2`; `helm upgrade` without the `replicaCount` override).

Ingest is down between steps 2 and 3. To roll back, stop the new replicas, restore the backup and start the previous version: it cannot run on the migrated schema (its rollup writes fail), so deploying the previous tag is not a rollback for this release. The regression test `apps/server/test/storage/old-writer-compat.test.ts` runs the 0.6.0 statements against the new schema and fails if this changes.

## TLS and the reverse proxy

The server speaks plain HTTP on one port and serves ingest, `/login`, the dashboard and the API on it. Put a TLS-terminating proxy in front and do not publish the server's port. What the server needs from the proxy:

- **`Host` passed through unchanged.** The server checks the `Origin` of dashboard writes against it.
- **`X-Forwarded-For` set by the proxy** (replacing, not appending to, anything a client sent), and **`NESTRIX_TRUSTED_PROXIES`** set to the proxy's address or network. Only a connection from a trusted address may name the visitor, and the login limit keys on that address. Without it every visitor shares one login limit.
- **A request body limit of at least 20 MiB.** The server accepts bodies up to 20 MiB; nginx's default `client_max_body_size` is 1 MB, which refuses large OTLP batches with 413.
- **Health checks against `/readyz`** if the proxy does them (Swarm and Kubernetes do it for you).

Caddy (certificates obtained and renewed by itself; ports 80 and 443 must reach it from the internet):

```
nestrix.example.com {
	encode zstd gzip
	reverse_proxy nestrix:4318
}
```

Caddy passes `Host` through and sets `X-Forwarded-For` to the client's address when no `trusted_proxies` are configured. The Swarm stack's `Caddyfile` is this plus the environment variable for the domain; its certificate step needs a real domain and was not tested here.

nginx:

```nginx
server {
  listen 443 ssl;
  server_name nestrix.example.com;
  ssl_certificate     /etc/ssl/nestrix/fullchain.pem;
  ssl_certificate_key /etc/ssl/nestrix/privkey.pem;
  client_max_body_size 20m;

  location / {
    proxy_pass http://nestrix:4318;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;   # not $proxy_add_x_forwarded_for, unless this is the first proxy and you trust it
  }
}
```

On Kubernetes, an Ingress does the same job; the chart's `ingress` values and an ingress-nginx and cert-manager example are in the [chart README](https://github.com/nestrix-js/nestrix/tree/main/deploy/helm/nestrix-server#tls). Set `NESTRIX_PUBLIC_URL` to the public `https://` address so alert links point at it.

## Shutdown and health checks

From the code: `/livez` answers while the process runs and ignores the database; `/readyz` answers 200 only when the database answers, every migration is applied and today's partitions exist, and answers 503 from the moment shutdown begins. On `SIGTERM` the server drains its write queue for up to 10 seconds and its webhook sender for up to 10 seconds, then closes the pool. Give it 30 seconds (`stop_grace_period`, `terminationGracePeriodSeconds`) rather than Docker's default of 10. Use `/readyz` for readiness and `/livez` for liveness: a database outage should take replicas out of rotation, not restart them.

## Optional features and their settings

Each of these is off, or unchanged from earlier releases, until you set it. The server README has the variables and what they cost:

- Single sign-on and viewer/admin roles: `NESTRIX_OIDC_ISSUER`, `NESTRIX_OIDC_CLIENT_ID`, `NESTRIX_OIDC_CLIENT_SECRET` (or `_FILE`), `NESTRIX_OIDC_ADMIN_GROUPS`, `NESTRIX_OIDC_ALLOWED_GROUPS`, `NESTRIX_ADMIN_PASSWORD_LOGIN` ([Users, roles and single sign-on](https://github.com/nestrix-js/nestrix/tree/main/apps/server#users-roles-and-single-sign-on)). Set `NESTRIX_PUBLIC_URL` (or `NESTRIX_OIDC_REDIRECT_URL`) to the address behind your TLS proxy.
- Environments: entries of `NESTRIX_INGEST_KEYS` written as `<environment>:<key>` bind a key to an environment, so a staging key cannot write production data ([Environments](https://github.com/nestrix-js/nestrix/tree/main/apps/server#environments)).
- Log search: `NESTRIX_LOGS=all`, `NESTRIX_LOG_RETENTION_DAYS`, `NESTRIX_LOGS_MAX_PER_TRACE`, `NESTRIX_LOGS_MAX_PER_MINUTE`. `all` stores every log line and grows the database; size it with the storage formula above ([Log search](https://github.com/nestrix-js/nestrix/tree/main/apps/server#log-search)).
- Historical metrics: `NESTRIX_METRICS=on`, `NESTRIX_METRICS_MAX_SERIES_PER_SERVICE`, `NESTRIX_METRICS_MAX_SERIES` ([Historical metrics](https://github.com/nestrix-js/nestrix/tree/main/apps/server#historical-metrics-optional)).
- Attribute filters: `NESTRIX_INDEXED_ATTRIBUTES` ([Attribute filters](https://github.com/nestrix-js/nestrix/tree/main/apps/server#attribute-filters)).

## Checklist

- Image pinned by version and digest.
- Disk from the formula, with an alert on free space.
- A `pg_dump` on a schedule, and a restore tried once.
- Secrets as files or from your secret store; `NESTRIX_INGEST_AUTH=none` not set.
- TLS in front, `Host` passed through, `NESTRIX_TRUSTED_PROXIES` set, 20 MiB body limit.
- Two replicas with the same `NESTRIX_SESSION_SECRET` and `PORT`, if you want availability (README, "Running several instances").
