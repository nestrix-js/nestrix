---
"@nestrix-js/nestjs": minor
---

Measure how long `pg` waited for a pooled connection (#38). The `pg` integration now also wraps `Pool.prototype.connect` (which `pool.query()` uses) and records `db.client.connection.wait_time` (seconds), `db.client.connection.count` (`idle`, `used`) and `db.client.connection.pending_requests` per `db.client.connection.pool.name` (`host:port/database`, never the user or password) through the OpenTelemetry metrics API, so a host `MeterProvider` or Prometheus bridge sees them; nothing with `metrics: false`. Inside a trace, an acquisition that found no free client and waited at least `integrations.pg.poolWaitThresholdMillis` (default 5 ms; `false` for none) adds a short `pg.pool.connect` span, so a request that waited for a free connection no longer looks like a slow query. Query spans still cover the query only, and a free client adds nothing.
