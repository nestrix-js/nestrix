# Nestrix demo

A small NestJS 12 shop with Nestrix: method spans (`NestrixInstrument`), `pg` query spans against a real Postgres, an N+1 pattern, a deliberately slow query, an error, an outbound HTTP call, users and a release. It sends itself a request every 0.7 s so the dashboard fills up.

```bash
docker run -d --rm --name nestrix-demo-pg -p 127.0.0.1:55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:18-alpine
pnpm install && pnpm build
PORT=3300 pnpm --filter demo start
```

Open the `Nestrix dashboard: http://localhost:3300/_nestrix/auth?token=…` link the app logs. Things to look at:

- `GET /reports/revenue`: a slow query (`pg_sleep`), highlighted in the waterfall, under `OrdersRepository.revenueReport`.
- `GET /orders`: `SELECT name FROM customers WHERE id = $1` six times; the trace's Queries panel groups the repeats.
- `GET /archive`: a query on a missing table, in Errors.
- Classes, Map, and the user and release columns in the request list.

Stop with Ctrl+C and `docker stop nestrix-demo-pg`. `DATABASE_URL` overrides the database.
