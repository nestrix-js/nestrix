# Levels 1 to 3

Nestrix adds detail in levels. Each one needs a little more setup than the last.

| Level | What you get | Setup |
|---|---|---|
| 1 | HTTP server spans, outgoing HTTP spans, exceptions | `NestrixModule.forRoot()` |
| 2 | A span per method of your own classes | `instrument: NestrixInstrument` in `main.ts` |
| 3 | Database and cache spans, and BullMQ jobs | Automatic for `pg`; options for the rest |

## Level 1: HTTP

One server span per request, named `METHOD /route/template` (or just `METHOD` when no route matched, as for a 404). It carries the OpenTelemetry HTTP attributes, `code.function.name` (`Controller.handler`), the status, and the first exception a handler or pipe threw as an exception event. An incoming `traceparent` is continued.

`node:http` and `fetch` (undici) calls made inside a request get a client span and a `traceparent` header. A request made with no active parent span (a health poller, an error reporter's transport outside a request) gets neither.

Server spans carry no `client.address`: the caller's IP is personal data.

## Level 2: method spans

Pass Nestrix's `instrument` object to `NestFactory.create`. This is Nest's own `instrument` option, which hands every instance to a decorator as it is created.

```ts
import { NestFactory } from "@nestjs/core";
import { NestrixInstrument } from "@nestrix-js/nestjs";
import { AppModule } from "./app.module";

const app = await NestFactory.create(AppModule, {
  instrument: NestrixInstrument,
});
await app.listen(3000);
```

Nest accepts one `instrument` object. To combine with another tool, use `composeInstrument(NestrixInstrument, otherTool)`.

A method span is named `Class.method` and carries `nestrix.class`, `nestrix.method` and `nestrix.component` (`controller`, `service`, `repository`, `processor`, `guard`, `pipe`, `interceptor`, `filter` or `provider`). Spans nest under the request's server span: controller, then service, then repository, then the database span.

**What is traced by default.** The controllers, services, repositories and queue processors that your application's modules list. Nestrix reads the static `@Module()` metadata from the root module, following `imports` that are module classes.

- Providers that come from a library are not traced.
- A module with `forRoot`, `forRootAsync`, `forFeature`, `forFeatureAsync`, `register` or `registerAsync` is not entered, so a service in **your own** dynamic module is not traced until you `include` it.
- Guards, pipes, interceptors and filters get no span unless you set `methods.enhancers`.

```ts
NestrixModule.forRoot({
  methods: {
    include: [PaymentsGateway, /Client$/], // a class, an exact name or a RegExp
    exclude: ["HealthService"], // wins over include
    enhancers: ["guard"], // or true for all four kinds
  },
});
```

**Only inside a trace.** A method called with no active span (startup work, a WebSocket handler) gets no span, but is still counted in the dashboard's classes view. Scheduled methods (`@Cron`, `@Interval`, `@Timeout`) start a new root trace on every run with `nestrix.entry = "scheduled"`.

**Things to know.**

- There is no `Proxy`. `this` stays the real instance, so `#private` members work, and method-level `@UseGuards` keeps applying.
- The promise a traced method returns must be handled by its caller. A method that handles its own promise (`p.catch(log); return p`) while its caller ignores the return value turns a rejection into an unhandled one.
- `@nestjs/testing` is not supported: Nest gives the testing module no `instrument` option. HTTP spans still work there. See the [FAQ](/faq) and [Testing your app](/guide/testing).

## Level 3: database and cache

A database span is a child of the method or request that ran the query. Spans use the OpenTelemetry database conventions (`db.system.name`, `db.operation.name`, `db.query.text`, `db.namespace`, `server.address`, `server.port`).

| Library | Default | How |
|---|---|---|
| `pg` | on, when `pg` is installed | Wraps `Client.prototype.query`, `Pool.prototype.query` and `Pool.prototype.connect` (pool wait). Covers raw `pg`, `pg-cursor`, `pg-query-stream` and ORMs built on `pg` (TypeORM, Drizzle, Prisma on `@prisma/adapter-pg`, MikroORM). |
| `mysql2` | off | Subscribes to mysql2's tracing channels (mysql2 3.20 or later). |
| `ioredis` | off | Subscribes to ioredis's channels (ioredis 5.11 or later). |

```ts
NestrixModule.forRoot({
  integrations: {
    pg: true, // the default; false turns it off
    mysql2: true, // opt-in
    ioredis: { rootSpans: false }, // opt-in
  },
});
```

**Why `mysql2` and `ioredis` are opt-in.** Both libraries change behaviour once anything subscribes to their tracing channels. With `mysql2`, an event-emitter query that fails with no `'error'` listener normally raises `uncaughtException`; once Nestrix subscribes, it is silently swallowed. With `ioredis`, a failing command nobody awaits normally raises `unhandledRejection`; once Nestrix subscribes, it does not. That turns a crash into silence, so you opt in knowingly (decision D-49).

**What a span records.** The statement with literals replaced by `?` (strings, numbers, hex and boolean literals; `IN (...)` lists collapsed; comments dropped; cut to 2,048 characters). If Nestrix cannot parse a statement safely it records a fixed placeholder, never the raw text. **Bind parameters are never recorded**, and there is no option to. For Redis the span records the command and its first argument (`GET user:1`), never values. A database span covers the query only, so a saturated connection pool shows as a gap before the span.

**`pg` pool wait.** For `pg`, that gap is measured: `db.client.connection.wait_time` (seconds, per `db.client.connection.pool.name`, every successful acquisition), `db.client.connection.count` (`idle` and `used`) and `db.client.connection.pending_requests`, through `@opentelemetry/api` (nothing with `metrics: false`). Inside a trace, an acquisition that found no free client and waited at least `integrations.pg.poolWaitThresholdMillis` (default `5`) also gets a short `pg.pool.connect` span between the caller and its first query; a free client adds nothing. `{ pg: { poolWaitThresholdMillis: false } }` keeps the metrics and drops the span. The pool name is `host:port/database`, never the user or password. A failed acquisition records no wait; a failed `pool.query()` keeps its error span.

**`pg` and nested copies.** An ORM may bring its own copy of `pg`. Nestrix wraps copies loaded when it starts and again at `onApplicationBootstrap`. A copy first loaded during a request is not traced.

**`ioredis` and root commands.** A command with no active span (the connection handshake, commands queued before the connection was ready) is dropped by default. `ioredis: { rootSpans: true }` keeps them as root spans.

## Mail and other outgoing channels

An HTTP-API mail provider (SES over HTTPS, SendGrid, Postmark, Resend) is already traced as an outbound call. SMTP is not: nothing traces a raw TCP or TLS conversation. Two options, both opt-in:

- **Name the class.** Put the Nest provider that sends mail in `methods.include`: `methods: { include: [MailService] }`. This works on classes Nest instantiates as providers; a transport object a library creates internally is not one.
- **Wrap the send** in `withSpan('mail.send', ...)` and record only the transport name and the outcome:

```ts
import { Injectable } from "@nestjs/common";
import { withSpan } from "@nestrix-js/nestjs";

// Whatever sends your mail: nodemailer, a vendor SDK over SMTP, a queue.
interface MailTransport {
  readonly name: string;
  send(message: { to: string; subject: string; html: string }): Promise<void>;
}

@Injectable()
export class MailService {
  constructor(private readonly transport: MailTransport) {}

  async sendWelcome(to: string): Promise<void> {
    return withSpan("mail.send", async (span) => {
      // Only the transport and the outcome. No address, subject or content.
      span.setAttribute("mail.transport", this.transport.name);
      try {
        await this.transport.send({
          to,
          subject: "Welcome",
          html: "<p>Hi</p>",
        });
        span.setAttribute("mail.outcome", "sent");
      } catch (error) {
        span.setAttribute("mail.outcome", "failed");
        throw error; // withSpan records it and sets the error status
      }
    });
  }
}
```

Keep addresses, subjects and bodies off the span. A `net`/`tls`-level span for SMTP clients is not planned: those sockets carry the message itself, so a generic instrumentation could not know what to leave out.

## BullMQ jobs

BullMQ has its own OpenTelemetry support, through its `telemetry` option. Give it `bullmqTelemetry()` from `@nestrix-js/nestjs` (no other package needed) and it records its own spans and carries the trace context in each job, in the API and in a separate worker process (`createApplicationContext`) alike:

```ts
import { bullmqTelemetry } from "@nestrix-js/nestjs";

BullModule.forRoot({
  connection: { host: "localhost", port: 6379 },
  telemetry: bullmqTelemetry({ tracerName: "my-app" }),
});
```

It looks its tracer up when BullMQ first uses it, so it works wherever you create it. A failed job marks its `process` span as an error, with the failure reason as the exception; the job's return value is never recorded; BullMQ's parentless housekeeping spans (the stalled-jobs check every 30 s per worker) are dropped unless `rootSpans: true`. `enableMetrics: true` adds BullMQ's job metrics.

**Not `new BullMQOtel()` in an ESM app.** `bullmq-otel` 2.0 is CommonJS only, so it uses the CommonJS copy of `@opentelemetry/api` while Nestrix uses the ESM copy; created inline in `BullModule.forRoot()`, it takes its tracer before Nestrix registers its provider, and BullMQ's spans are silently missing. If you keep it, build it on first use (getters for `tracer` and `contextManager`; the README's "Background jobs" section has the code).

A job added during a request stays in that request's trace. The consumer span is a child of the producer span, with no span link, however much later the worker ran it:

```text
GET /orders                      server
  OrderController.place
    OrderService.place
      add emails.welcome         producer (BullMQ)
        process emails           consumer (BullMQ, runs later in the worker)
          EmailProcessor.process method span, nestrix.entry = "job"
          complete emails        ("fail emails" when the job failed)
```

A job added outside a request starts a trace of its own. Without `telemetry`, a `@Processor`'s method span is a root span. Nestrix does not wrap BullMQ: BullMQ makes the spans and Nestrix shows them. In the dashboard the `jobs` type filter shows traces that a job started.
