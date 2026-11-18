# Nestrix server on Docker Swarm

`stack.yml` runs three services: the server (2 replicas), PostgreSQL, and Caddy for TLS. The reasoning for every number is in [docs-site/guide/production.md](../../docs-site/guide/production.md).

What the stack sets: the image pinned by version and digest; the four secrets as files (`*_FILE`); a health check on `/readyz`; `stop_grace_period: 30s` (the server drains for up to 20 s on `SIGTERM`); rolling updates that start the new replica first and roll back on failure; requests and limits from the sizing guide; PostgreSQL pinned to one labelled node with a local volume; Caddy in host mode so the server sees visitors' real addresses.

## Before the first deploy

You need a Swarm (`docker swarm init`), a DNS name pointing at the node that runs Caddy, and ports 80 and 443 open to the internet (for the certificate).

```bash
# 1. Where the stateful services run (one node may carry both labels).
docker node update --label-add nestrix-db=true   <node>
docker node update --label-add nestrix-edge=true <node>

# 2. The four secrets. Generate them, keep a copy in your password manager.
openssl rand -hex 24 | docker secret create nestrix_db_password -
openssl rand -hex 24 | docker secret create nestrix_ingest_keys -        # one key, 48 characters; several: comma-separated
openssl rand -hex 24 | docker secret create nestrix_admin_password -     # 12+ characters; this is the dashboard login
openssl rand -hex 32 | docker secret create nestrix_session_secret -     # 32+ characters, shared by every replica

# 3. Deploy.
export NESTRIX_DOMAIN=nestrix.example.com
docker stack deploy --detach=false -c deploy/swarm/stack.yml nestrix
```

`--detach=false` waits until every service converges and fails if a replica does not become healthy. To read the ingest key later: services cannot print secrets; keep your copy.

## Check it

```bash
docker stack services nestrix                         # server 2/2, postgres 1/1, proxy 1/1
curl -s https://$NESTRIX_DOMAIN/readyz                # {"status":"ok"}
```

Point your apps at it with `OTEL_EXPORTER_OTLP_ENDPOINT=https://nestrix.example.com` and `OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <the ingest key>`. Sign in at `https://nestrix.example.com/login` with the admin password.

## Upgrade

Read the release notes, back up (below), read the new digest (`docker buildx imagetools inspect ghcr.io/nestrix-js/nestrix-server:<version>`), change the tag and digest in `stack.yml`, and `docker stack deploy` again. If the notes say "stop all replicas first": `docker service scale nestrix_server=0` before deploying.

## Backup and restore

```bash
# Backup, from the node that runs PostgreSQL (the dump is written on that node).
docker exec $(docker ps -q -f name=nestrix_postgres) \
  pg_dump --format=custom --no-owner -U nestrix -d nestrix -f /tmp/nestrix.dump
docker cp $(docker ps -q -f name=nestrix_postgres):/tmp/nestrix.dump ./nestrix-$(date +%F).dump

# Restore into a new database, then point the server at it (or restore with the stack stopped and rename).
docker cp ./nestrix-2026-11-18.dump $(docker ps -q -f name=nestrix_postgres):/tmp/restore.dump
docker exec $(docker ps -q -f name=nestrix_postgres) createdb -U nestrix nestrix_restored
docker exec $(docker ps -q -f name=nestrix_postgres) \
  pg_restore --exit-on-error --no-owner -U nestrix -d nestrix_restored /tmp/restore.dump
```

## External PostgreSQL

Delete the `postgres` service, the `pgdata` volume and the `nestrix_db_password` secret from `stack.yml` (and the secret from the server service), remove `DATABASE_PASSWORD_FILE`, and give the server the whole URL through a secret: create `nestrix_database_url` holding `postgres://user:password@host:5432/nestrix?sslmode=require`, add it to the server's secrets, and set `DATABASE_URL_FILE: /run/secrets/nestrix_database_url` instead of `DATABASE_URL`. The database needs rights to create tables and partitions in its schema.

## Rendering without a Swarm

```bash
NESTRIX_DOMAIN=nestrix.example.com docker stack config -c deploy/swarm/stack.yml
```

prints the resolved file and fails on a missing variable or a syntax error. CI runs it.
