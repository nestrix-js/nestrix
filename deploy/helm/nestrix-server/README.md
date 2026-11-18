# nestrix-server Helm chart

Runs the standalone Nestrix server (default 2 replicas) and, by default, a single-node PostgreSQL StatefulSet. The reasoning for every number is in [docs-site/guide/production.md](../../../docs-site/guide/production.md).

What the chart sets: the image pinned by version and digest; secrets mounted as files and passed through the `*_FILE` variables (the chart never takes a secret value); `/livez` liveness, `/readyz` readiness and startup probes; a `preStop` sleep and a 30 s grace period for the server's drain; rolling updates with `maxUnavailable: 0`; a PodDisruptionBudget; each pod mounts only the Secret keys it reads (the bundled PostgreSQL gets the database password and nothing else); requests and limits from the sizing guide; a non-root, read-only-root-filesystem, no-capabilities security context for the server.

Needs Kubernetes with a default StorageClass (for the bundled PostgreSQL) and Helm 3.

## Install

```bash
# 1. The Secret. The chart reads these keys (names are configurable under existingSecret.keys).
kubectl create namespace nestrix
kubectl -n nestrix create secret generic nestrix \
  --from-literal=db-password="$(openssl rand -hex 24)" \
  --from-literal=ingest-keys="$(openssl rand -hex 24)" \
  --from-literal=admin-password="$(openssl rand -hex 16)" \
  --from-literal=session-secret="$(openssl rand -hex 32)"

# 2. Install.
helm install nestrix-server deploy/helm/nestrix-server -n nestrix \
  --set existingSecret.name=nestrix \
  --set config.publicUrl=https://nestrix.example.com
```

The release is named `nestrix-server` in these commands, so the objects are called `nestrix-server` and `nestrix-server-postgres`; another release name gives `<name>-nestrix-server`.

## Check it

```bash
kubectl -n nestrix rollout status deploy/nestrix-server
kubectl -n nestrix port-forward svc/nestrix-server 4318:4318 &
curl -s localhost:4318/readyz       # {"status":"ok"}
```

Point your apps at `http://nestrix-server.nestrix.svc:4318` (inside the cluster) with `OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <ingest key>`; read the key back with `kubectl -n nestrix get secret nestrix -o jsonpath='{.data.ingest-keys}' | base64 -d`.

## TLS

Enable the Ingress and give it a certificate. With ingress-nginx and cert-manager:

```yaml
# values-prod.yaml
config:
  publicUrl: https://nestrix.example.com
  trustedProxies: ["10.42.0.0/16"]      # the ingress controller pods' CIDR
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
    nginx.ingress.kubernetes.io/proxy-body-size: 20m   # the server accepts 20 MiB bodies; nginx defaults to 1 MB
  hosts: [nestrix.example.com]
  tls: [{ secretName: nestrix-tls, hosts: [nestrix.example.com] }]
```

`helm upgrade --install nestrix-server deploy/helm/nestrix-server -n nestrix -f values-prod.yaml --set existingSecret.name=nestrix`. `trustedProxies` matters: without it every visitor shares one login rate limit.

## Your own PostgreSQL

`--set postgresql.enabled=false` and add a `database-url` key to the Secret holding the whole URL (`postgres://user:password@host:5432/nestrix?sslmode=require`).

## Upgrade

Read the release notes, back up (below), read the new digest (`docker buildx imagetools inspect ghcr.io/nestrix-js/nestrix-server:<version>`), set `image.tag` and `image.digest`, and `helm upgrade`. If the notes say "stop all replicas first": `kubectl -n nestrix scale deploy/nestrix-server --replicas=0` before `helm upgrade`.

## Backup and restore

```bash
kubectl -n nestrix exec nestrix-server-postgres-0 -- \
  pg_dump --format=custom --no-owner -U nestrix -d nestrix -f /tmp/nestrix.dump
kubectl -n nestrix cp nestrix-server-postgres-0:/tmp/nestrix.dump ./nestrix-$(date +%F).dump

kubectl -n nestrix cp ./nestrix-2026-11-18.dump nestrix-server-postgres-0:/tmp/restore.dump
kubectl -n nestrix exec nestrix-server-postgres-0 -- createdb -U nestrix nestrix_restored
kubectl -n nestrix exec nestrix-server-postgres-0 -- \
  pg_restore --exit-on-error --no-owner -U nestrix -d nestrix_restored /tmp/restore.dump
```

The bundled PostgreSQL is one pod on one volume with no failover: use a managed or operator-run PostgreSQL if you need that.

## Lint and render

```bash
helm lint deploy/helm/nestrix-server --set existingSecret.name=x
helm template t deploy/helm/nestrix-server --set existingSecret.name=x
```

CI runs both.
