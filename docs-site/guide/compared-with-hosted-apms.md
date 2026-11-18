# Compared with hosted APMs

This page helps you decide between Nestrix and a hosted application performance monitoring (APM) service, or use both. It compares Nestrix with a **category**, not with named products. It states what Nestrix does and does not do, as built; it does not describe any vendor's features, limits or prices, because those change and belong in the vendor's own documentation. The right-hand column of the table below is therefore generic and approximate: check it against the service you are considering.

## Who Nestrix is for

- A NestJS 12+ team that wants traces, errors and route statistics without an account, an agent or a bill, and is happy to run the data store itself.
- A team that cannot or does not want to send request telemetry to a third party. With no OTLP endpoint set, nothing leaves the process; with the standalone server, everything stays in your own PostgreSQL.
- A team that already runs an OpenTelemetry backend and wants better Nest spans going into it.

It is not a fit if you want a fully managed service with someone else operating storage, scaling and upgrades, or if you need front-end (browser) monitoring in the same product.

## What Nestrix does that generic OpenTelemetry or APM tools do not

- **Nest-aware spans.** Server spans are named by route template; controller handlers, your own services and repositories, queue processors and scheduled methods get spans, and guards, pipes, interceptors and filters can be switched on. BullMQ jobs and microservice message patterns are traced across processes, and `pg`, `mysql2` and `ioredis` calls are recorded. See [Levels 1 to 3](/guide/levels) and the [package README](https://github.com/nestrix-js/nestrix/blob/main/packages/nestjs/README.md#what-is-traced).
- **Built on NestJS 12's own hooks.** No `node --import` or loader flag, no patching of Nest internals and no `Proxy` around providers ([FAQ](/faq#does-it-use-a-proxy-or-need-preload-flags)).
- **A dashboard your own app serves.** Install `@nestrix-js/ui` and open `/_nestrix`. It is closed unless something positive opens it (your machine in development; a token or your own check elsewhere), and its API never sends CORS headers ([Security model](/guide/security)).
- **No data egress by default.** Request and response bodies, bind parameters and headers outside an allowlist are not recorded ([Privacy](/faq#privacy)).
- **Errors that count once.** An exception that travels up through method spans is one occurrence, and expected 4xx exceptions are not errors ([Errors](/guide/errors)).
- **MCP access.** `@nestrix-js/mcp` lets an AI assistant read traces, errors and route statistics from either backend ([MCP](/guide/mcp)).

## What you give up

- **No managed service.** You run, size, back up and upgrade the standalone server and its PostgreSQL ([Running in production](/guide/production)). The embedded dashboard keeps recent traces in process memory (5,000 traces or 32 MiB by default) and loses them on restart.
- **Short, bounded retention.** The standalone server keeps 7 days by default, configurable up to 3,650 (`NESTRIX_RETENTION_DAYS`), and it is bounded by your disk. Retention is one value for the server, not per environment.
- **Self-hosted, one deployment.** There is no multi-region or managed global service. Replicas of your apps are supported; replicating the server itself is up to you.
- **No front-end monitoring and no synthetic checks.** Nestrix instruments the NestJS process. It has no browser or mobile monitoring, session replay or scheduled external checks, and the repository contains none.
- **Metrics are thin.** The embedded Runtime page shows the last hour. The standalone server can store Nestrix's own runtime metrics (`NESTRIX_METRICS=on`) and serve them at `/api/v1/metrics`, but the dashboard has no metric charts yet, and it is not a general metrics backend: only its fixed catalog is stored ([server README](https://github.com/nestrix-js/nestrix/blob/main/apps/server/README.md#historical-metrics-optional)).
- **Logs are context first.** Log lines are shown next to a trace. Search across all lines exists only in the standalone server with `NESTRIX_LOGS=all`, and it is bounded by caps and retention ([Log search](https://github.com/nestrix-js/nestrix/blob/main/apps/server/README.md#log-search)). It is not a log management product.
- **Alerts go to a webhook only.** There is no built-in email, chat or paging integration; you receive a signed webhook and route it yourself.
- **Only the standalone server has the team features:** error triage, SLOs, alerts, environments, roles and single sign-on, attribute filters and time ranges up to the retention. The embedded dashboard has none of these.
- **Smaller ecosystem.** Nestrix is pre-1.0 (see the [Compatibility](/reference/compatibility) page for what is tested), supports NestJS 12 and later and Node.js 26.13 and later, and has no vendor support contract.

## Using Nestrix next to another backend

Nestrix exports standard OTLP, so it does not exclude another backend.

- **The embedded dashboard and an OTLP backend together.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` (or `export.otlp.endpoint`) and the dashboard keeps working from its in-memory store while spans also go to that endpoint. `export.otlp` takes one endpoint; to reach several backends, point it at an OpenTelemetry Collector and configure the fan-out there.
- **Your own OpenTelemetry SDK.** If the app already runs an SDK, Nestrix creates none and its spans go through yours, to whatever exporters you configured. Add `nestrixSpanProcessor()` to feed the dashboard ([FAQ](/faq#what-do-i-do-if-my-app-already-runs-an-opentelemetry-sdk)).
- **Logs and metrics** go out over OTLP too (`logs: { export: true }`, and Nestrix's metrics through your `MeterProvider`), so a metrics or log backend you already use keeps working ([Logs and metrics](/guide/logs-and-metrics)).
- **Another APM agent in the same process.** Tools that use only the OpenTelemetry API or diagnostics channels coexist. Two tools that both install Nest's single request hook replace each other, so run one hook-based APM per process ([FAQ](/faq#does-it-work-next-to-another-apm)).
- **A common split:** the embedded dashboard in development and staging, the standalone server or your existing backend in production.

Moving between Nestrix and a hosted service is a matter of endpoint and headers, because both sides speak OTLP. What changes is the table below.

## Capability table

"Embedded" is `@nestrix-js/ui` served by your app. "Standalone" is the `nestrix-server` image with PostgreSQL. The last column is deliberately generic: hosted APMs differ from one another, so read it as "what you would typically look for", not as a statement about any one product.

| | Nestrix embedded | Nestrix standalone | Typical hosted APM |
|---|---|---|---|
| Traces | Recent traces in process memory, waterfall, critical path | Stored in PostgreSQL, several services and replicas as one service | Stored and queried by the vendor |
| Nest-aware spans | Yes: route templates, controllers, services, guards and other enhancers (opt-in), BullMQ, microservices, `pg`, `mysql2`, `ioredis` | Same spans, sent by your apps | Varies; check whether guards, pipes, providers and jobs get their own spans |
| Errors and triage | Grouped by type, message and route; New, Ongoing, Quiet; no stored triage state | Same, plus stored resolved, ignored and regressed states per service and environment, and an alert for new or regressed groups | Typically grouping and triage; check the states offered |
| Logs | Next to the trace (bounded, in memory) | Next to the trace; opt-in search across all lines (`NESTRIX_LOGS=all`) | Typically searchable and retained by the vendor |
| Metrics | Runtime page, last hour | Opt-in storage of Nestrix's runtime metrics with an API; no dashboard charts yet | Typically custom and infrastructure metrics |
| Alerts | None | Rules on error rate, p95, SLO burn rate and new error groups; webhook delivery only | Typically several notification channels |
| SLOs | None | Availability and latency objectives over 7 or 30 days, error budget, burn rates | Varies |
| Profiling | On-demand CPU profile with flame graph | Remote CPU capture of one instance (apps opt in with `export.profiler`) | Varies |
| Sampling | Ratio, plus local tail keep for errors and slow requests (`sampling.keepErrors`, `keepSlowerThanMs`) | Apps sample the same way; the server weights counts by the keep probability | Varies; check the sampling controls |
| Environments | No | `deployment.environment.name`, filter on every view, ingest keys bound to an environment | Typically supported |
| SSO and roles | Startup token, your own auth check | Admin password; optional OIDC single sign-on with viewer and admin roles; read-only API tokens; audit log | Varies; SSO and roles are typical |
| Retention | Bounded by memory (`store.maxTraces`, `store.maxBytes`); lost on restart | 7 days by default, up to 3,650, bounded by your disk | Set by the vendor |
| Hosting | Inside your app process | You run the server and PostgreSQL (Docker image, Helm chart and Swarm stack in the repository) | Vendor-operated |
| Data location | Your process; nothing sent unless you set an endpoint | Your database, in the region you pick; single deployment | Vendor's regions |
| Cost model | Free, Apache-2.0; costs a little memory and CPU in your app | Free, Apache-2.0; you pay for the server and database | Typically a subscription or usage-based fee |

## Choosing

- **Start with embedded** if you want to see what the app is doing today: nothing to run, and nothing leaves the machine.
- **Move to standalone** when you need more than one process in one view, history past a restart, shared sessions for a team, or alerts, SLOs and triage.
- **Keep or add a hosted service** if you need front-end monitoring, longer or managed retention, notification channels beyond a webhook, or someone else running the backend. Keep Nestrix's spans: they go to it over OTLP.
