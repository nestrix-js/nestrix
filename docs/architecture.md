# Architecture

The canonical description of what Nestrix is and how it is built. It supersedes the planning document it grew from. Decisions and who made them are logged in [decisions.md](decisions.md); the facts behind them are in [research.md](research.md) and [nest-hooks.md](nest-hooks.md); the order of work is in [roadmap.md](roadmap.md).

Several mechanisms below are marked **(spike)**. They are designed from reading source, not yet proven by running code. Phase 0 exists to prove or correct them, and this document is updated with the result.

## 1. What Nestrix is

The open-source way to see what a NestJS 12 app is doing: run one install command, import one module, and get Nest-aware OpenTelemetry traces, either in a dashboard served by the app itself or in whatever backend you already run.

Why a NestJS developer would install it:

1. A local dashboard at `/_nestrix` with nothing else to run and no account: requests, their waterfall, errors, slow routes.
2. Standard OTLP out, to Jaeger, Tempo, Grafana, Datadog or an OpenTelemetry Collector, with spans that understand Nest (route templates, controllers, guards, message patterns), on a Nest version the upstream OpenTelemetry instrumentation does not cover.
3. A permissive licence and telemetry you may send anywhere.

Position: the open, OpenTelemetry-native, self-hostable alternative to the Nest team's hosted `@nestjs/observe`, whose licence ties its agent to its own service.

Supported: NestJS 12.0+ (microservice propagation needs `@nestjs/microservices` 12.0.4+, platform-node needs 12.3.2+, D-44), Node 22.15+, Express 5, Fastify 5 and platform-node.

## 2. Scope

| Capability | Decision | Phase |
|---|---|---|
| HTTP monitoring | Build, on Nest's adapter hooks | 1 |
| Exception monitoring | Build: handler exceptions first; guard and filter exceptions when enhancer spans are opted in (D-47) | 1, 3 |
| Outbound HTTP | Small first-party subscribers for fetch/undici and `node:http` (D-42) | 1 |
| Custom tracing | Thin helpers over the OpenTelemetry API | 1 |
| Embedded dashboard | Build | 2 |
| Method spans | Build, on Nest's `instrument` option. By default controllers, queue processors and scheduled methods; services and guard, pipe, interceptor and filter spans opt in (D-47) | 3 |
| Database and cache | Build thin driver-level spans for `pg` (on when present), `mysql2` and `ioredis` (opt-in, D-49). Nothing ORM-specific. | 3 |
| Background jobs | Reuse BullMQ's own telemetry; scheduled jobs through level 2 | 3 |
| Microservices | Build on Nest's packet-metadata hooks | 4 |
| Standalone server | Build | 5 |
| Logs | Correlation ids, then optional OTLP export. Storage and search stay with existing log backends. | 6 |
| Metrics | Delegated to the OpenTelemetry Metrics API. Nestrix adds request-duration and runtime metrics. | 6 |
| Health monitoring | Not built. `@nestjs/terminus` does it. | — |

Deferred, with no phase yet: MongoDB driver spans (candidate: the driver's command-monitoring events), GraphQL resolvers, WebSocket gateways, alerting, profiling, service map, multi-tenancy, an `init` CLI, NestJS 11 support, ClickHouse storage, SQLite persistence for the embedded store.

## 3. One pipeline, three modes

```
 Nest hooks ─┐
 diagnostics ├─► @opentelemetry/api ─► TracerProvider ─┬─► BatchSpanProcessor ─► OTLP/HTTP exporter   (headless, standalone)
 channels    │      (spans, context)   (host's own, or │
 integrations┘                          one Nestrix    └─► store processor ─► bounded in-memory store
                                        creates)                               ─► query API ─► UI      (embedded)
```

- Instrumentation code writes through `@opentelemetry/api` only. It never knows which mode is active.
- A mode is a choice of span processors. Headless is the exporter alone. Embedded adds the in-memory store. Standalone is a separate service that receives the same OTLP.
- The UI talks to one versioned HTTP query API. That API, with its types in `packages/protocol`, is the contract between the UI and whatever serves it. The embedded store and the standalone server each implement the API; they do not share a storage interface until a second implementation shows what it should be.
- Headless and embedded ship together in the first release. Standalone follows in phase 5.

## 4. Design

### 4.1 Integration levels

| Level | What the developer does | What they get |
|---|---|---|
| 1. Module only | `imports: [NestrixModule.forRoot()]` | HTTP server spans with route template and status; exceptions thrown by handlers; outbound HTTP spans and `traceparent` propagation; microservice handler spans and client-side propagation (phase 4); the dashboard; OTLP export |
| 2. One line in `main.ts` | `NestFactory.create(AppModule, { instrument: NestrixInstrument })` | Spans for controller methods, scheduled jobs and queue processors by default; services, guards, pipes, interceptors and filters by opt-in (D-47). Exceptions thrown by guards are captured when their spans are on. Not applied under `@nestjs/testing` (D-48) |
| 3. Library spans | Nothing for `pg`: it switches on when present and can be switched off. `mysql2` and `ioredis` are opt-in, one setting each (D-49). One line of BullMQ's own config for jobs. | Query and command spans, which cover TypeORM, Drizzle and Prisma on `@prisma/adapter-pg` (verified, P0-S2); MikroORM, including when its `pg` is a nested copy that was already loaded (the module-cache scan of §4.4, D-50); Knex not tested. Job spans. Enabling `mysql2` or `ioredis` makes the library swallow certain errors instead of crashing (§4.4); the docs say so where the option is introduced. |
| 4. Anything else | The user sets up an upstream `@opentelemetry/instrumentation-*` package with the loader flags upstream documents | Kafka client, AMQP, MongoDB driver, gRPC spans. They use the same OpenTelemetry API, so they join the same traces. Nestrix neither manages nor requires the flags. Caveat (P0-S3): in a CommonJS app where Nestrix owns the provider, an upstream instrumentation constructed or registered before Nestrix registers produces no spans (it took its tracer from the `.cjs` API copy at construction). The host must construct it after `NestFactory.create`, or own the provider itself. |

The plan states these levels openly instead of promising zero-code instrumentation for everything.

### 4.2 Level 1 mechanics

Read [nest-hooks.md](nest-hooks.md) first; the rules here are consequences of it.

**HTTP server span**
- `setOnRequestHook`: extract W3C context, start the server span, then call `done()` inside the span's context so the rest of the request inherits it. The hook is synchronous, calls `done()` exactly once on every path, and cannot throw.
- The span ends on the raw response's `close` event, attached in the request hook; the listener holds the span itself, because on a client abort it runs outside the request's async context. Status at `close`: `headersSent` true means `statusCode` is what was sent; `writableEnded && !writableFinished` means delivery was cut after the app finished; `!headersSent && !writableFinished` means no response, so no status code is recorded (P0-S1). Node versions (settled in P1-06; research.md "Delivery cut, `writableFinished` and Node versions"): before Node 24.20 `writableFinished` is already true at `close` when the client cut delivery after the app ended the response, so Nestrix also reads the request's socket: `nestrix.http.aborted` is set when `!writableEnded`, or `!writableFinished`, or `req.socket.destroyed` at `close`. The socket check was run on Node 22.15, 24.16 and 26.13: true for every cut and abort, false for completed keep-alive, `Connection: close`, HTTP/1.0, pipelined and unread-body responses and for 16 MiB responses read in full; `packages/nestjs/test/http-server.test.ts` asserts, on all three adapters and on 22.15 and 26, that the cut and both kinds of abort are marked and that none of these is: 16 MiB read in full (keep-alive and `Connection: close`), HTTP/1.0 with and without keep-alive, three pipelined requests, a client half-close after the request (HTTP/1.1 and 1.0), a 4 MiB request body left unread (sent fully and partly), `Upgrade: websocket` to a normal route, `HEAD`, and `Expect: 100-continue`. A response the app itself destroys is also marked aborted (indistinguishable at `close`). `setOnResponseHook` is not used.
- Route template from `setOnRouteTriggered`, chained with any existing callback through `getOnRouteTriggered()`. It carries no request, so Nestrix's own server span is found through a context key Nestrix owns, never `trace.getActiveSpan()`, which may be another tool's span (under Sentry's Express instrumentation it renamed Sentry's handler span; P0-S3 Q4c'). The route is also kept in Nestrix's own per-request state, because `updateName` on a non-recording span does nothing and the route statistics of §4.6, recorded before sampling, must not depend on the span (P0-S3 Q2: `routeStats` is correct under `AlwaysOffSampler`). The route hook only records the route; the name and `http.route` are applied at `close`, because the 404 rule below may have to drop them and a span attribute cannot be removed once set. The interceptor, which has the request but may run in a context another tool replaced (P0-S3 Q4c), finds the same state through the raw `IncomingMessage` (a `WeakMap`), not through the context (P1-06).
- Both hooks are set from a provider constructor, because routes are registered before `onModuleInit`. If no adapter is available at construction (`@nestjs/testing`), the constructor subscribes to `HttpAdapterHost.init$`, which emits when the adapter is set and before routes are registered; both hooks work from that callback. The subscriber's entire body catches everything (a throw there becomes an asynchronous `uncaughtException`). `init$` emits no value (the setter calls `_init$.next()`, then completes it), so the subscriber reads `httpAdapter` from the host. In apps without HTTP the adapter is then `null`, or `init$` never emits, and nothing is installed (P1-06, `test/http-no-adapter.test.ts`). This relies on `init$`'s code, not its JSDoc, so a nightly test on the latest Nest 12.x asserts `http.route` under `@nestjs/testing` (P0-S1).
- A 404 has no route: the span is named by method alone. Under header, media-type or custom versioning, and with host filters, the route hook fires before the filters decline, so a request that no version accepts would otherwise keep a route name. Rule: if the final status is 404 and Nestrix's global interceptor never ran for the request, `http.route` is dropped. Guard rejections keep their name. Run in P1-06 on Nest 12.4.2 (`test/http-404-rule.test.ts`), counting route-hook calls for a request no handler accepted: header, media-type and custom versioning fire the hook twice (once per version) on Express and platform-node and not at all on Fastify (versions are a router constraint there); a declining host filter fires it once on all three adapters. In every case the span ends as `GET` with no `http.route`. Cases that lose a name they should keep: a guard that throws a 404 (`NotFoundException`), because guards run after the route hook and before Nestrix's interceptor; and a host global interceptor that runs before Nestrix's and throws a 404. A handler that throws a 404 keeps its name (the interceptor ran).
- Attributes (P1-06, stable names from `@opentelemetry/semantic-conventions` 1.45.0): `http.request.method` (`_OTHER` plus `http.request.method_original` for a method outside the conventions' list, and the span is then named `HTTP`), `url.path`, `url.query` (redacted), `url.scheme`, `network.protocol.version`, `user_agent.original`, allowlisted request and response headers, `http.route`, `http.response.status_code` (only when headers were sent), `error.type`, `code.function.name` (interceptor) and `nestrix.http.aborted`. Not recorded: `client.address` (an IP address is personal data) and `server.address`/`server.port` (they would come from the `Host` header, which is outside the allowlist). An origin-form target is split by the server itself, so a target starting with `//` keeps its first segment in `url.path` (`splitUrl` reads a leading `//` as an authority, P1-04); any other form (absolute-form, `*`) goes through `splitUrl`, which drops scheme, authority and userinfo. `ignore.routes`: a string matches the path exactly, a `RegExp` is tested with `search` (so `g`/`lastIndex` do not matter), a function must return `true`; a matcher that throws counts as a match (the request is ignored) and the failure is counted, as `options.ts` documents. An ignored request gets no server span; tracing is not suppressed inside it, so other tools' spans are unaffected.
- Registration timing: Nestrix registers its OpenTelemetry globals no earlier than `NestFactory.create` (provider construction or later), never at import or `forRoot()` time. In an ESM `main.ts` that imports `AppModule` and then starts the host's SDK in the module body, `forRoot()` runs first, and registering there takes every slot from the host: the host's `setGlobal*` calls return `false` and its exporter gets no spans (P0-S3 Q1a; shown by a stand-in that registers early, no fixture with `forRoot()` at import time was built).
- Supported versions: the hook shape above behaves the same on 12.0.0 and 12.4.2 for Express and Fastify. platform-node needs 12.3.2 or later for context across its body parsers (P0-S1). Supported: `@nestjs/platform-node` from 12.3.2; Express and Fastify adapters from 12.0.0 (D-44).

**Handler attribution and exceptions**
- A global interceptor (`APP_INTERCEPTOR`), registered by the module, sets `code.function.name` (`Controller.handler`), marks the request as having reached a handler (the 404 rule), and records the first exception thrown by a handler or pipe as an exception event. It calls `next.handle()` once and returns it through a `tap` whose error callback is guarded, so values, completion and the error object pass through unchanged. It acts only on `http` contexts with a Nestrix server span.
- Error status is decided at `close`, not in the interceptor: `ERROR` when the status sent is 5xx, or, when nothing was sent, when the recorded exception maps to 5xx (an `HttpException`'s own status, duck-typed; anything else counts as 500). `error.type` is the exception's class name when that exception maps to 5xx, otherwise the status code. So an `HttpException` below 500 is an event with status unset, and an error a filter turns into a 200 is an event with status unset (conformance table; `test/http-server.test.ts` on all three adapters).
- Interceptor order (P1-06/07 review, `test/http-interceptor-order.test.ts`, Express): Nest runs `APP_INTERCEPTOR` providers in module order, so a host module imported before `NestrixModule` puts its global interceptor before Nestrix's. Whatever such an interceptor throws never reaches Nestrix's interceptor: a 404 it throws ends as `GET` with no route and no exception event, and a 500 it throws sets error status from the status code but records no exception event. With `NestrixModule` imported first, the same 404 keeps the route and is recorded. The docs recommend importing `NestrixModule` first in the root module.
- No global exception filter. Exceptions thrown by guards are captured when guard spans are opted in at level 2 (D-47); at level 1 a guard rejection keeps its route name and records no exception.
- Process-level errors: an `uncaughtExceptionMonitor` listener only. It sees uncaught exceptions and, under Node's default `--unhandled-rejections=throw`, unhandled rejections too (`origin === "unhandledRejection"`; run on 22.15 and 26.13). An `unhandledRejection` or `uncaughtException` listener is never added: adding either stops the default crash (run: with an empty `unhandledRejection` listener the process stays alive and exits 0 on 22.15 and 26.13). Best effort: inside a traced request the error becomes an exception event on Nestrix's server span; otherwise a short span named after `origin`. The process usually exits right after the monitor, before the batch processor exports, so these reach the exporter only when the host handles the error and the process survives. `test/process-errors.test.ts` shows, in a child process, that Nestrix adds exactly one `uncaughtExceptionMonitor` listener and that an unhandled rejection and an uncaught exception still exit with status 1, as without Nestrix.
- Known limit (P1-06): on platform-node, `Content-Type` and `Content-Length` that the adapter's `writeBody` passes to `writeHead(status, headers)` are not visible through `getHeaders()`, so those response headers are missing from its spans. Reading them would need the private `_header` field or patching the response; Nestrix does neither.

**Outbound HTTP**

Implemented in `packages/nestjs/src/outbound/` (P1-08, P1-09): `rules.ts` holds what both subscribers share, `node-http.ts` and `undici.ts` the two subscribers, and `installOutbound(options, diagnostics)` in `index.ts` subscribes and returns an idempotent unsubscribe. There is one subscription per process, reference-counted: a second Nestrix application in the same process takes a reference (and logs once that the first installation's options apply), and the channels are unsubscribed only when the last application releases its reference, so closing one app does not stop tracing for another that is still running. Shared rules:
- No span and no header when the context carries the suppress-tracing key or has no active span with a valid span context (rules 1 and 2 below). An active but unsampled parent still gets a non-recording client span, so the `traceparent` sent carries the sampling decision. SDK 3's `Tracer.startSpan` and the W3C propagator also honour the suppress key themselves (`sdk-trace` 3.1.1 `Tracer.mjs:43`, `core` 3.1.1 `W3CTraceContextPropagator.mjs:38`), so Nestrix's own check is defence in depth that also skips the URL and span work.
- `ignore.outgoing` is matched against the URL as recorded in `url.full` (no userinfo, no fragment, host lowercased, listed query values already `REDACTED`). For `node:http`, `url.full` has no port when the caller set its own `Host` header (see the port rule below), so a prefix that includes a port does not match those requests. A string matches as a URL prefix; a RegExp is tested (its `lastIndex` reset); a function must return `true`. A matcher that throws counts as a match (the request is not traced) and is counted as a failure.
- Headers are injected through `propagation.inject` (whatever propagator is registered). Nothing is injected when the request already has a `traceparent`, so the caller's header is neither overwritten (`node:http` replaces) nor duplicated (undici appends, sending two `traceparent` values; run on Node 22.15, 24.22 and 26.13), and no `tracestate` is added beside a caller's `traceparent`. Otherwise each field is added only when the request does not already carry it, so a header another tool set (`baggage`) is kept as it is.
- URL privacy: a request target in absolute form (a request to a forward proxy) has its userinfo removed first, up to the last `@` before the path, so a `#` or `@` in a password cannot cut it short; if what remains does not parse as a URL, only its path is recorded (through `splitUrl`), never the raw target.
- A body the caller cancels after the response head is not an error: the span ends with `nestrix.http.body = "cancelled"`, no exception event, and the status recorded from the head stands (a cancelled 500 is still an error because of its status code). Before the head every failure is an error. How a cancel is told apart from a server or network cut is per client, below; the evidence is in research.md, "Cancel or cut after the response head".
- Attributes: stable HTTP client conventions `http.request.method` (`_OTHER` plus `http.request.method_original` for a method outside the standard set, and the span is then named `HTTP`; the standard set includes `QUERY`, stable in semantic conventions 1.45.0), `url.full`, `server.address`, `server.port`, `http.response.status_code`, `error.type` (the status code from 400 on, else the error's string `code` such as `ECONNREFUSED`, else its name), and the request and response header allowlists of §4.8. Span name `METHOD`, kind `CLIENT`. Status from 400 on and any error set error status; an error also records an exception event.
- fetch and undici: a first-party subscriber on undici's diagnostics channels (D-42). Request/response flows (`fetch`, `undici.fetch`, `undici.request`) were verified on Node 22.15, 24.22 and 26.13 with the global `fetch` and with an npm undici copy (7.30.2; 8.12.4 on 24 and 26). Upgrade requests differ: on Node 22.15 (bundled undici 6.21.2) a global `WebSocket` publishes only `undici:request:create`, with no head, trailers or error; undici 7 and later (Node 24, 26, and any npm 7+ copy) publish `headers` (101) and `trailers`. Channels are matched by name, so one subscription sees every undici copy in the process (research.md, "undici diagnostics channels"). Which copy runs a request can also differ from what the caller imported: Node's own `fetch` and `WebSocket` use the process-wide global dispatcher, and an npm undici loaded before their first request creates that dispatcher, so on Node 22.15 a global `WebSocket` then publishes the head as undici 7 does. The span starts in `undici:request:create` (published in the caller's async context), `traceparent` is added there with `request.addHeader` and reaches the wire, the head is recorded from `undici:request:headers`, and the span ends on `undici:request:trailers` (body fully received) or `undici:request:error`. Unread body: undici buffers a small body (so it completes) but stops reading a large one, and then neither `trailers` nor `error` ever comes (`bodyTimeout` does not fire while the body is paused). So a timer starts at the head (30 s, restarted by `undici:request:bodyChunkReceived` where undici publishes it: Node 24 and 26, not 22.15); if it fires first, the span ends at the head time with `nestrix.http.body = "not consumed"`. The global `fetch` cancels an unread body when its `Response` is garbage-collected and publishes that as `undici:request:error` with a string; that also ends the span at the head as not consumed, not as an error. After the head, an `undici:request:error` that is the caller cancelling (an `AbortError` from `res.body.cancel()`, from aborting the signal or from destroying `undici.request`'s body, or a non-Error value passed to `cancel(reason)`) ends the span as cancelled; a server or network cut (`SocketError`, `UND_ERR_SOCKET`) stays an error, and so does an abort whose reason is the caller's own Error object or an `AbortSignal.timeout()` (`TimeoutError`). For an upgrade or `CONNECT` request the same timer is also armed at `create`, so on undici 6 the span ends when it fires, without a head; its duration is then the grace, not the request's. Known limitation: a body that takes longer than the grace to arrive (from the head on Node 22.15, between chunks on 24 and 26) gets a head-only span marked not consumed. The upstream instrumentation is not used: it depends on `@opentelemetry/instrumentation`, which brings `require-in-the-middle` and `import-in-the-middle`, and constructing it installs a process-wide `Module.prototype.require` hook even though undici needs no patching (P0-S2 Q1).
- `node:http` client: a first-party subscriber on Node's `http.client.*` channels (P0-S2 Q2; all four channels are published on Node 22.15, 24.22 and 26.13). The mechanism:
  - start the span in `http.client.request.created`, with the caller's active context, and inject there with `setHeader` under the injection rule above; tolerate a `setHeader` failure silently (headers passed as an array make it throw `ERR_HTTP_HEADERS_SENT`; the request then goes out unchanged, with no header, and nothing is counted);
  - `ClientRequest` exposes no port: `server.port` comes from the `Host` header Node writes (`host[:port]`, port only when not the scheme's default) when it names the same host as `request.host`; when the caller overrode `Host`, or for a Unix socket, the port is left out of both `server.port` and `url.full` (so an `ignore.outgoing` prefix with a port does not match such a request). The host is lowercased;
  - end the span on the response's `close` event (attached from `http.client.response.finish`), or on `http.client.request.error`. An incomplete response (`!response.complete`) is a cancel when the caller ended it (`req.destroy()` or `res.destroy()` after the head): the response looks the same as after a server cut (`ECONNRESET` in both cases), but the socket does not, since after a server close it has ended (`readableEnded`), after a reset or a caller's `destroy(error)` it carries an error, and after a caller's plain destroy it has neither. Otherwise it is an error, with the response's own error when it has one, else `error.type = response_incomplete`. A caller that destroys the request on its own timeout (`req.setTimeout(...)` then `destroy()`) is indistinguishable from a cancel and is recorded as one. `response.finish` fires when the response head is parsed, not at the end of the body, so ending there cuts the span short and a mid-body abort looks successful;
  - if, on the `setImmediate` after `response.finish`, nothing is consuming the body (`readableFlowing === null` and no `'readable'` listener), end the span at the response head and set `nestrix.http.body = "not consumed"`, otherwise `close` never comes and the span never ends. A caller that starts reading on a later tick gets a head-only span (known limitation);
  - a request that never gets a response head through the channels (an `'upgrade'` or `'connect'` response) ends when the request emits `close`; the only listeners Nestrix adds are this `close` on the request and `close` on the response, never `'error'`.

**Sharing hooks with another tool**
- Nest's request hook is a single slot with no getter. Nestrix does not try to chain it. Only one hook-based APM can run per process; Nestrix checks at bootstrap whether another is installed and warns clearly.
- For the `instrument` slot, Nestrix exports `composeInstrument(a, b)`.

**Rules for every hook and subscriber**
- Wrap the whole body. A request hook that throws fails the user's request; a diagnostics-channel subscriber that throws raises `uncaughtException`.
- Failures are counted and logged once, not per request.
- Nestrix's own routes and its exporter's requests are never traced, by three rules (P0-S3):
  1. honour OpenTelemetry's suppress-tracing context key (`createContextKey("OpenTelemetry SDK Context Key SUPPRESS_TRACING")`, reachable through the API alone). It covers every SDK exporter, because both span processors wrap export in `suppressTracing` (`BatchSpanProcessorBase.mjs:99`, `core/internal/exporter.mjs:10`, 3.1.1); fetch through upstream undici was skipped under `suppressTracing()` too (P0-S3);
  2. create no client span and inject no header when there is no active parent span. That skips background requests such as Sentry's envelope POSTs outside a request;
  3. a configurable host ignore list, for requests made inside a request on behalf of another tool: Sentry's transport does not set the suppress key, so an envelope sent from inside a failing request is otherwise a child span carrying `traceparent`.
- Decide inside the guard, then call the wrapped original exactly once, outside it. A synchronous throw from the library itself must reach the caller once and must not be counted as a Nestrix failure (P0-S2: the first `pg` wrapper called `pg` twice).
- Never add an `'error'` listener to a library's stream or emitter; end cursor and stream spans through the library's own internals (the `pg` wrapper uses `handleReadyForQuery`/`handleError`).
- Subscribing to a library's TracingChannel can itself change that library's behaviour (P0-S2 Q7: mysql2 and ioredis test the combined `hasSubscribers`), so whether an integration subscribes is a behaviour decision, not only a cost one. See §4.4.
- Any subscription to a Nest observable (`HttpAdapterHost.init$`) needs the same guard as a diagnostics-channel subscriber (P0-S1, P0-S3).
- Obtain tracers at use time (`trace.getTracer()` inside the hook), never at module top level (P0-S2, P0-S3; see §4.5).
- `enabled: false` or `NESTRIX_ENABLED=false` registers nothing at all.

### 4.3 Level 2 mechanics

Nest's `instanceDecorator` sees every DI-created instance after construction and before any explorer captures its methods. Nestrix wraps methods; it does not return a `Proxy`.

Requirements, each backed by a test:
- Wrappers copy all reflect-metadata keys, own properties, `name` and `length` from the original function. Without this a method-level `@UseGuards` becomes invisible and the route fails open.
- The receiver stays the raw instance, so `#private` members and identity checks keep working.
- Wrappers are installed as non-enumerable own properties of the instance; the prototype is never changed (swapping it reorders Express routes). The decorator returns the instance it was given and is idempotent.
- Wrappers are cached per class, so request-scoped instances cost no closure allocation per request; installing them still costs about 150–200 ns per wrapped method per instance (P0-S6).
- A wrapper calls the method the class prototype holds at call time, so patches made after decoration (test spies) apply; it falls back to the copy captured at decoration.
- Only a plain native promise (`Object.getPrototypeOf(p) === Promise.prototype`) is followed, returned as `p.then(end, endAndRethrow)`. A method returning a memoised promise therefore returns a new object on each call: an accepted behaviour change. A second accepted change follows from the same shape (P1-05 review): if the method handles its promise itself (`p.catch(log); return p`) and the caller ignores the returned value, the derived promise's rejection is unhandled, so under Node's default `--unhandled-rejections=throw` the process exits where it would not have. No public API can observe a promise without either this risk or marking it handled, which would silence real unhandled rejections; the derived promise is the lesser change, and the docs say that the promise a traced method returns must be handled by its caller. This applies to `@Span` (phase 1) and to level 2 wrappers. Promise subclasses, other thenables and Observables are returned untouched and their span ends when the method returns, so an Observable's span covers none of the stream and misses its errors. Generators and accessors are not wrapped.
- Functions and non-class values pass through untouched.
- Only prototype methods are wrapped, never callable own properties.
- Entry methods (scheduled jobs, queue processors) start a new root span linked to the span active at call time.
- What is wrapped by default (D-47): controllers, queue processors and scheduled methods. Services opt in through `include`, and so do guard, pipe, interceptor and filter spans; there is no denylist of framework classes to keep up to date (evidence in spike P0-S6, Q1, Q7). Users can always `include` and `exclude` by class or pattern.
- Under `@nestjs/testing`, level 2 does not apply in 0.2 and the docs say so; HTTP spans still work there (D-48; [nest-hooks.md](nest-hooks.md) §4).

Wrappers skip span creation when the parent span context is valid and lacks `TraceFlags.SAMPLED`, so an unsampled request costs about 70 ns per wrapped call over a raw call; without the skip a non-recording span still costs about 0.7 µs (P0-S6). `Span.isRecording()` is not the test: in SDK 3 it turns false as soon as a sampled span ends, which would drop spans for work that outlives the request.

### 4.4 Level 3 mechanics

| Library | Mechanism | Needs module access |
|---|---|---|
| mysql2 3.20+ | Subscribe to its TracingChannels. Query and execute spans are children of the caller, on pool and connection, with `database, query, serverAddress, serverPort, values` in the context. **Context bug (P0-S2 Q3):** when the pool queues a caller, `mysql2:query` is published inside the releasing caller's async context, so a queued handler's query lands in another handler's trace. Fix: lend the caller's context from `mysql2:pool:connect` (published in the caller's context; its `asyncStart`/`asyncEnd` bracket the callback) to queries started synchronously inside the pool callback. Later work in that callback is still misparented. The fuller fix, verified on Node 26 only, is `tracingChannel('mysql2:pool:connect').asyncStart.bindStore(als, msg => callerContext)` on the AsyncLocalStorage behind the context manager, which needs Nestrix to own the context manager (§4.5). The span excludes pool wait time. **Opt-in (D-49)**, because subscribing changes mysql2's behaviour (below). | No |
| ioredis 5.11+ | Subscribe to its channels (`args` already sanitised by ioredis). Known gaps (P0-S2 Q4): a command issued before the connection is ready is traced only when the offline queue flushes, so it is a root span in its own trace, and handshake commands (`HELLO`, `CLIENT SETINFO`, `INFO`) are root spans. Rule for root `redis` spans (drop them, or keep them only if the user opts in): a phase 3 implementation detail the lead settles (proposed: drop root `redis` spans unless the user opts in). `ioredis:batch` (MULTI) and `ioredis:connect` are not subscribed or tested. **Opt-in (D-49)**, because subscribing changes ioredis's behaviour (below). | No |
| `pg` | Wrap `Client.prototype.query` and `Pool.prototype.query` after load. Verified (P0-S2 Q5): the module object that `createRequire` reaches is the same one ESM `import pg from 'pg'` and CJS `require('pg')` give the app (pg's `esm/index.mjs` wraps the CJS module). Raw `pg`, `pg-cursor`, `pg-query-stream`, TypeORM, Drizzle and Prisma on `@prisma/adapter-pg` are traced, in ESM and CJS apps. The wrapper changes nothing observable (P0-S2 Q7). Needs pool/client de-duplication: wrapping both prototypes counts every `pool.query` twice, and under contention the inner client span lands in another caller's trace. The pool wrapper hands pg-pool a marked config object (a string becomes `{ text }`) and the client wrapper skips a marked config; the mark must be reference-counted, one token per pool call, not a set, or concurrent `pool.query` calls sharing one config object (a named prepared statement) lose marks. Residual ambiguity (measured): a direct `client.query(sameConfig)` issued while a `pool.query` with that object is queued consumes the pool's token, so the direct query gets no span. A per-call `Object.create(config)` is an untested alternative. Replace with channels when `pg` ships them. | Yes: `pg` is declared as an optional peer so strict package managers let Nestrix resolve it. pnpm 12.16.1 links the optional peer to the `pg` in the graph, even when the app never lists `pg` and with `hoist: false`; with no `pg` anywhere the integration reports itself disabled. **Nested copies are not reached by `createRequire`**, and they are common: MikroORM 7.2.8 pins `pg` exactly (8.23.1), so an app on any other `pg` gets a nested copy, and a forced override produced 0 MikroORM spans. Decided (D-50): also wrap every `…/node_modules/pg/lib/index.js` already in `require.cache`, with no double wrapping, at enable and again at `onApplicationBootstrap`. Verified in plain-node probes only; the timing in a Nest app is **unverified** and is checked first thing in phase 3. Copies loaded after the last scan stay untraced, and the docs say so. |
| BullMQ | Its own `telemetry` option with `bullmq-otel`; `@nestjs/bullmq` forwards it to workers. Nestrix documents it and renders the spans. | No Nestrix code |

Subscribing to a channel nobody publishes costs nothing, so the channel integrations are effectively free when the library is absent. Each integration is a small file with no dependencies of its own, loaded lazily. `pg` is on when present; `mysql2` and `ioredis` are off until the user enables them (D-49).

**Subscribing can change the library's behaviour (P0-S2 Q7).** mysql2 and ioredis test the TracingChannel's combined `hasSubscribers`, which is true once any sub-channel has a subscriber, and then take a `tracePromise` path. With mysql2, an event-emitter query that fails with no `'error'` listener raises `uncaughtException` and closes the connection when nothing subscribes, and is silently swallowed once anything subscribes. With ioredis, an unawaited failing command raises `unhandledRejection` with no subscriber and nothing with one. In a default app (`--unhandled-rejections=throw`) that is crash to silence. No subscription style avoids it (a single `tracing:<name>:start` subscriber changes the same things as a full set). A `mysql2:pool:connect`-only subscriber changed nothing in 48 observations, but gives no query spans. Decided (D-49): the mysql2 and ioredis integrations are opt-in, per integration, so that rule 1 holds by default; enabling one documents that the library then swallows these errors instead of crashing. This amends D-3's "switch on when the library is present" for those two.

**Pool wait time.** The `pg` pool span starts at `pool.query()` and includes waiting for a connection; the mysql2 query span starts when the query is sent and excludes it. One rule for all drivers is proposed in P0-S2: a database span covers the query only (as mysql2's channel and pg's own Client spans do), and pool wait is a separate measure (`db.client.connection.wait_time`). For `pg` the pool wrapper would record the caller's context with the token and let the client wrapper open the span with that parent when the inner query starts. Not implemented. Proposed for phase 3: database spans cover the query only; the lead settles it there.

Statements are recorded with literals replaced by `?`. Bind parameters are never recorded unless explicitly enabled.

### 4.5 OpenTelemetry usage

**Reused from upstream:** the API; SDK 3.x (`@opentelemetry/sdk-trace`, resources); `@opentelemetry/context-async-hooks` and `@opentelemetry/core` (D-41); the OTLP/HTTP exporter; semantic conventions; `bullmq-otel`.

**First-party, and why:**

| Piece | Why not upstream |
|---|---|
| Nest instrumentation | Upstream does not support Nest 12, patches internals and covers HTTP handlers only |
| `node:http` client spans | Upstream is patch-based; Node publishes channels |
| fetch/undici client spans | Upstream installs a process-wide `require` hook and two loader libraries; undici publishes channels (D-42) |
| mysql2, ioredis spans | Upstream is patch-based; both libraries publish channels |
| `pg` spans | Upstream needs experimental loader flags; a small wrapper does not |

This is a deliberate, narrow exception to "do not duplicate mature infrastructure". Each first-party piece is a thin subscriber or wrapper, and the alternative is asking every user for Node flags that are deprecated or discouraged.

**When the host already has an SDK.** Nestrix calls `trace.setGlobalTracerProvider()`. If it returns `false`, a provider exists: Nestrix creates no SDK, its instrumentation keeps working through the API, and export is the host's business. For the dashboard, the host adds `nestrixSpanProcessor()` to its own `spanProcessors`; Nestrix logs that hint. The host's SDK must be 3.x. Hosts on SDK 2.x are not supported in 0.1 (D-40, below).

Verified (P0-S3 Q1 to Q3, stand-in, ESM and CJS hosts, Express, Fastify and platform-node, Node 22.15 and 26): with a host SDK 3 provider registered first, host and Nestrix spans form one correctly parented chain through the host's exporter, `traceparent` goes out, and context crosses the two API copies across `await`. Details:
- **Context manager and propagator.** SDK 3's `TracerProvider` has no `register()`, and `sdk-trace` exports no AsyncLocalStorage context manager (`StackContextManager` only), so hosts register through the API, and a Nestrix-owned provider needs an ALS context manager and a W3C propagator. Nestrix probes for both and registers neither when one exists. Context manager: `context.with(ROOT.setValue(k, m), () => context.active().getValue(k) === m)` is false under the no-op manager and true otherwise; the same check after an `await` reveals a sync-only `StackContextManager`, which can only drive a warning, because the slot is taken. Propagator: `propagation.fields()` is `[]` for the no-op and `["traceparent","tracestate"]` for W3C. There is no public getter for either. The probes are silent. Trying `setGlobal*` and checking for `false` also works, but each failed call writes `Attempted duplicate registration of API` with a stack to the host's diag logger, `setGlobalTracerProvider` included. Settled in P1-03: the provider check calls `setGlobalTracerProvider` and accepts that one line, while the context manager and the propagator are probed and never tried. No public probe for a provider is silent: a probe span goes through the host's sampler and processors and is exported (P0-S3 Q3); one started under a non-sampled remote parent is silent only under a `ParentBased` sampler; `ProxyTracerProvider.getDelegate()` is deprecated. The line reaches only a diag logger the host set. After a lost race Nestrix remembers what `trace.getTracerProvider()` returned and does not try again while it returns the same object, so the line appears once per host registration, not once per app: once per process unless the host disables its provider and registers another (api 1.10.0 `trace.disable()` replaces the proxy object), which costs one more line. Nestrix's own log says the host's SDK is used and which options are ignored (`packages/nestjs/test/otel-host-provider.test.ts`: one line across five app lifecycles, a second after the host re-registers). The ALS context manager and the propagator come from `@opentelemetry/context-async-hooks` and `@opentelemetry/core` (D-41, dependency budget below).
- **`nestrixSpanProcessor()`** is duck-typed across copies and sees every recording span, including the host's own (a sampler's `RECORD` or `RECORD_AND_SAMPLED`; not sampled-out spans). `onStart` and `onEnd` catch everything, and `forceFlush` and `shutdown` never reject: the SDK does not guard processor calls, so an unguarded one threw into host code and the host's request returned 500, and rejecting `forceFlush`/`shutdown` rejects the host's own.
- **A provider that loses the registration race** is shut down, and `shutdown()` reaches its processors, so it must never be built with a processor the host also uses.
- **Obtain tracers at use time, never at module top level** (P0-S2, P0-S3). `@opentelemetry/api` is dual-packaged, and each instance keeps a private `ProxyTracerProvider`; `setGlobalTracerProvider` sets the delegate on the registering instance's proxy only. A CJS host's module-level tracer therefore stays a no-op forever when Nestrix (ESM) registers, and registering through the `.cjs` copy only moves the problem to tracers taken early from the ESM copy. Tracers taken after registration work from either copy. No Nestrix-side mitigation is proven. Likewise, in a CJS host where Nestrix owns the provider, upstream instrumentations constructed before Nestrix registers stay no-ops (§4.1 level 4).
- **Registration timing** is in §4.2.
- **Exporter and suppress-tracing** rules are in §4.2 ("Rules for every hook and subscriber").

**Sentry.** `@sentry/node` 11.11.0 registers no provider, context manager or propagator by default (`enableOpenTelemetrySetup` defaults to `false`), so Nestrix owns all three and two tracers each start a trace. No setup tested gives one trace with Sentry's defaults and a fully working Nestrix (P0-S3 Q4; Express and an ESM host only; `@sentry/nestjs` 11.12.0 not tested):
- (a) Defaults: two traces and two header families. Each outbound call carries Nestrix's `traceparent` and Sentry's `sentry-trace`/`baggage` on different trace ids; the `/boom` error event carries Sentry's trace. Sentry continues no incoming `traceparent`.
- (b) The documented setup (`Sentry.init({ dsn, integrations: [Sentry.openTelemetryIntegration()] })` after registering your provider) still gives two traces, because Sentry's default integrations keep a non-recording Sentry span active and "an active Sentry span still takes precedence". With `defaultIntegrations: false` it is one trace, but Sentry loses its base default integrations (`onUncaughtException`, `onUnhandledRejection`, `linkedErrors`, `dedupe`, `contextLines`, `localVariables`, breadcrumbs and others); `SentryGlobalFilter` still captured. Which default integration holds the placeholder span was not bisected.
- (c) `enableOpenTelemetrySetup: true`: one trace, but Nestrix's context does not survive Sentry's Express instrumentation (cause inferred from parentage, not confirmed): client spans are children of Sentry's "Request handler", the server span keeps the name `GET` (no route), no `traceparent` goes out (`SentryPropagator` refuses a context other than the active one and prints a line to stderr per outbound call), and nothing reaches Nestrix's store.
Decided (D-43): Sentry is supported as coexistence. Both tools work side by side; with Sentry's defaults a request has two traces, (a) above, and the docs say so. Nestrix does not trace Sentry's envelope requests: the no-parent rule and the host ignore list of §4.2, because Sentry's transport does not set the suppress key. The setup of (b) is documented as an option, with the costs listed there. (c) is evidence only; D-43 does not adopt it.

**No `instanceof` on OpenTelemetry classes.** A CommonJS host loads the `.cjs` builds of the API and SDK while Nestrix, being ESM, loads the `.mjs` builds: two instances that share globals but not classes (spike P0-S4). Nothing in Nestrix may use `instanceof` on API or SDK classes (spans, providers, processors, exporters, contexts); `nestrixSpanProcessor()` and any check on a host-supplied provider or processor are duck-typed.

**Dependency budget.** At runtime `@nestrix/nestjs` depends on the SDK, resources, `@opentelemetry/context-async-hooks`, `@opentelemetry/core`, the OTLP exporter and semantic conventions, with `@opentelemetry/api` as a peer and `pg` as an optional peer. It does not depend on `@opentelemetry/instrumentation` or the undici instrumentation (D-42). Install size and startup cost are measured in phase 1 and published.

Three facts from P0-S2 and P0-S3 bear on the budget; each is decided (rule 10):

- Decided (D-41): a Nestrix-owned provider needs an ALS context manager and a W3C propagator, and `sdk-trace` exports neither, so `@opentelemetry/context-async-hooks` (3.1.1 is the SDK-3-compatible ALS context manager; peer `@opentelemetry/api >=1.0.0 <1.11.0`) and `@opentelemetry/core` (3.1.1, already present transitively, pinned exactly by `sdk-trace`) are runtime dependencies. Both are official Apache-2.0 packages. The P0-S2 stand-in registers the context manager. The fuller mysql2 context fix (§4.4) needs Nestrix to own the context manager (the stand-in reads a private field of the stock manager's ALS); a shipped version would own the class.
- Decided (D-42): `@opentelemetry/instrumentation-undici` is not a dependency. It pulled `@opentelemetry/instrumentation` with `require-in-the-middle` and `import-in-the-middle` and installed a global `Module.prototype.require` hook (§4.2); a first-party subscriber replaces it, which revisits D-13 for undici only.
- Decided (D-40): OpenTelemetry SDK 3 only for 0.1. Hosts on SDK 2.x are not supported; the docs explain the `ERESOLVE` and that they must upgrade. Background (O-1): npm refuses the install (`ERESOLVE`, peer `@opentelemetry/api >=1.10.0 <1.11.0` against the host's 1.9.1) unless the host passes `--legacy-peer-deps` or `--force`; pnpm installs with a warning. A second api copy fails silently in both directions, because the first registration of any kind stamps the global with that copy's version and a copy of another minor version can neither read nor write it: a Nestrix-owned 1.10 beside a host 1.9 global records nothing, and a Nestrix-owned 1.10 that registers first (even only a context manager) breaks the host's SDK 2 entirely. `@opentelemetry/api` stays a peer: Nestrix never carries its own api copy. Optional SDK packages remain possible later without breaking anyone.

### 4.6 Embedded dashboard

- **Store.** A bounded in-memory ring of recent traces, fed by a span processor. Bounded by trace count and by approximate bytes; oldest evicted first. Nothing is written to disk. Default limits come from measurement in phase 2.
- **Statistics under sampling.** Per-route request count, error count and a duration histogram are recorded in the request path before the sampling decision, so route statistics stay correct at any sample rate. Trace and error lists come from stored spans and are therefore sampled; the UI says so whenever the sample rate is below 1.
- **Mounting.** Routes are registered with the adapter's generic methods (`httpAdapter.get`) in `onModuleInit` (D-31, restated by D-45). The original reason, that constructor-time registration breaks platform-node, was disproved (spike P0-S5 showed registration through `HttpAdapterHost.init$` also works); the reason now is uniform behaviour across adapters, and host protections (auth middleware, rate limits, HSTS) also cover the dashboard. They work on all three adapters and under `@nestjs/testing`, and sit outside the host's global prefix, versioning, guards, pipes and interceptors, but **not** outside the host's exception filters.
- **Host layers.** Host middleware, `helmet`, `compression`, `enableCors()` and `app.useSecurityHeaders()` apply to the dashboard routes on every adapter. The dashboard sets its own `Content-Security-Policy` and every header it relies on, on every response; a handler's `setHeader` replaces the host's value.
- **Shadowing.** A host catch-all route, or `@nestjs/serve-static`'s SPA fallback, can shadow the dashboard on Express, and on platform-node whenever a `use()` sits between the host's routes and ours. Fastify was not affected. Nest has no public route table. Detection, two candidates (spike P0-S5): a startup self-request to our own route after `listen$` (runs host middleware and possibly the host's catch-all once, misreports host 401/429 as shadowing, skipped when `listen` is never called), or passive detection on the first real visit from the request and route hooks Nestrix already installs. Chosen in phase 2.
- **Handlers.** Every dashboard handler first takes over the raw response (`reply.hijack()` when the reply has one, i.e. Fastify; then `res.raw ?? res`), removes every `Access-Control-*` header, and catches everything, answering errors itself with a 500 through the same path (rule 1). An exception that escapes would reach the host's global filters.
- **Assets.** The file list is known at build time. Each file is an exact route, served from memory with immutable cache headers, written to the raw response (`statusCode`, `setHeader`, `end(buffer)`). Not through `httpAdapter.reply`, which JSON-encodes a `Buffer` on Express, nor `httpAdapter.end`, which drops headers on Fastify (spike P0-S5). No static-file plugin, no `@fastify/static` peer; the one per-adapter step is the duck-typed `hijack()`.
- **Base path.** `index.html` is templated per request with `<base href>` and a JSON config block. Assets are built with relative URLs.
- **Hash routing.** No catch-all fallback route is needed.
- **Live updates** by polling with a cursor every one to two seconds while the tab is visible. Server-sent events are deferred.
- **Scope.** Each process shows only its own traces. Embedded mode is for development and single-instance deployments.

### 4.7 Dashboard security

The dashboard can expose URLs, SQL and stack traces, so it is closed unless something positive says otherwise.

- `ui: 'auto'` (the default) serves the dashboard only when all of these hold: `@nestrix/ui` is installed; `NODE_ENV` is `development` or unset; the request carries the startup token (D-46, below); and, per request, the socket peer (`(req.raw ?? req).socket.remoteAddress`) is loopback (`127.0.0.0/8`, `::1`, `::ffff:127.0.0.0/104`), the raw `Host` header is present and names a loopback host, and none of `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`, `Via` is present. These are read from the raw socket and headers, never from `req.ip`, `req.hostname` or `getRequestHostname()`, which follow client-supplied forwarding headers when the host trusts proxies.
- **Limit of `ui: 'auto'`.** The checks cannot tell a local browser from a reverse proxy on the same host that adds no forwarding headers and rewrites `Host` to the upstream address, which is nginx's default for `proxy_pass http://127.0.0.1:<port>`. Such a deployment with `NODE_ENV` unset exposes the dashboard (spike P0-S5, run through a real proxy). The docs say so where `ui: 'auto'` is introduced. The startup token closes it (D-46): at startup Nestrix logs a link carrying a random token; opening it stores the token in an HttpOnly cookie, and without the cookie the dashboard stays closed. An explicit opt-out exists. The proxy case is then no longer open by default, because the proxy's visitors do not hold the token.
- Anything else, including staging and production, needs `ui: { enabled: true, auth }`. `auth` is either the built-in token authenticator (`{ token }`, compared in constant time) or a custom `authorize(request)`. Enabled without `auth`, Nestrix logs an error and leaves the dashboard off; the app starts normally.
- `authorize` receives the raw, adapter-specific request **before** any Nest guard has run, so `request.user` is not populated. The docs say this where the option is introduced.
- The dashboard API rejects requests with `Sec-Fetch-Site: cross-site`, and its responses never carry CORS allow headers, whatever the host's CORS configuration is: handlers hijack and strip as above, on success and error paths. On Fastify they never answer through `reply.send()`, because `@fastify/cors` with `hook: 'preSerialization'` runs after the handler and re-adds them. What Nestrix does not control: preflight (`OPTIONS`) requests for dashboard paths are answered by the host's CORS layer with the host's allow headers. A cross-origin page can then send the request but not read the response. This is acceptable only while the API is read-only; a state-changing endpoint would need its own CSRF defence.
- Read-only. `X-Robots-Tag: noindex`. Its own Content-Security-Policy; all assets same-origin; nothing inline is executed.

### 4.8 Privacy defaults

- No request or response bodies. Headers by a short allowlist. Query-string values redacted by key.
- Redaction is applied where Nestrix sets attributes, and again inside the store processor for every span it stores, including spans from other instrumentations. When the host owns the SDK, Nestrix cannot redact what the host's exporters send; the docs say so.
- In the owned export pipeline, redaction wraps the exporter and runs at export time, on the batch processor's timer, never in a request path (P1-03): each span is copied into an editable `RedactableSpan` (name, kind, attributes, event attributes, `status`), Nestrix's own scrub step runs, then the user's `redact` hook, and the copy is exported. Not a span processor: in `onEnd` the span is read-only, and SDK 3.1.1's experimental `onEnding` cannot delete attributes, edit events or drop a span. Consequence: spans wait unredacted in the in-memory queue until their batch is exported.
- What the hook sees: attributes, event attributes and `status` (`code`, and `message`, which often repeats an exception message; it may be rewritten or deleted). Links and their attributes are not exposed; for those the hook can only drop the span. The hook must be synchronous: a hook that returns a promise drops the span (fail closed), is counted, and its rejection is handled.
- Key-based redaction cannot clean free text. Exception messages are stored as they are; a `redact(span)` hook lets the user rewrite or drop them.

### 4.9 Performance and reliability

- Export is batched and asynchronous through a bounded queue. On overflow, spans are dropped and counted. Nothing in a request path waits on the exporter.
- Drop counting (settled in P1-03). `BatchSpanProcessor` keeps its drop count in a private field that it resets after each `diag.warn`, so Nestrix passes the processor's public, experimental `selfObsMeterProvider` option a meter whose only live instrument counts `otel.sdk.processor.span.processed` with `error.type = queue_full` (sdk-trace 3.1.1, `BatchSpanProcessorBase.mjs:64-68`, `SpanProcessorMetrics.mjs:40-42`). Spans whose export fails after the exporter's retries are counted separately, by the redaction wrapper around the exporter. `otel-drops.test.ts` pins the exact count (44 of 50 with a queue of 4 and batches of 2), so a minor SDK release that changes the option fails the test instead of silently reporting zero.
- Outage bound. During an outage at most one export is on the network, so memory is the processor's queue (`maxQueueSize` spans) plus one batch in flight (`maxExportBatchSize` spans, its serialized body and retry state), plus in a rare case one waiting batch (below). The exporter wrapper (`redacting-exporter.ts`) enforces this, because SDK 3.1.1's `BatchSpanProcessor` does not: after an export it saw **fail**, it starts the next export in `.finally()` and then clears its `_isExporting` flag in the chained `.catch()` (`BatchSpanProcessorBase.mjs:129-140`), so every later full batch starts another concurrent export, up to the exporter's `concurrencyLimit` of 30 (`otel-single-flight.test.ts` pins this, so it fails if the SDK fixes it). Two measures, settled in the P1-03 follow-up:
  - The wrapper never tells the processor that an export failed (except after the shutdown bound's `abort()`). It counts the spans in `exportFailedSpans`, hands the error to OpenTelemetry's global error handler (what the processor did with it), and answers `SUCCESS`. The processor's flag then stays right: during an outage it holds new spans in its queue and drops (and counts in `droppedSpans`) what does not fit, and on recovery the queued spans are exported. The processor does nothing else with a failure: no retry, no re-queue, only a self-observability metric Nestrix does not read.
  - A hard limit for when the flag is cleared anyway, which with the measure above happens only when the processor's own export timeout fires before the exporter answers: while an export is in flight, one further batch waits in the wrapper and starts when the first is answered; a batch beyond that is not sent, is counted in `exportFailedSpans`, is answered at once and is logged once (`otel.export-busy`). Holding one batch rather than none keeps the next batch after a blip that outlasts the timeout, at the cost of one batch of memory; holding more would make the bound depend on how long the collector hangs. Exports started by the processor's `forceFlush` (marked synchronously, since `_flushAll` hands over every batch before it returns) and every export after shutdown began are not limited, because the final flush hands over the whole queue at once and all of it must go; that flush is bounded by the queue.
  - Consequence: against a dead collector, shutdown now waits for its bound (the final flush is really attempted) instead of returning at once. Measured: 2.0 s with a 2 s bound, against 0 to 2 ms before; that the old flush failed at the exporter's limit of 30 is inferred, not traced.
  - Measured (manual probe `packages/nestjs/test/manual/otel-outage-probe.mjs`, darwin-arm64, Node 26.13, defaults: queue 2048, batch 512, exporter timeout 10 s; 20,000 spans/s for 150 s; forced GC each second): before shutdown, at most 1 socket open plus 1 closing for both a refusing and a never-answering collector (before the change: up to 31). Heap after GC 18.8 MB median against 11.9 MB for a healthy collector (before: 26.7 MB refusing, 21.8 MB rising to 27.3 MB never answering). RSS slope after minute 1 within ±0.5 MB/min, the same as the healthy control (before: +9.6 MB/min never answering). Details in research.md, "Export pipeline facts". P1-13's ten-minute benchmark is the reference.
  - The outage benchmark's pass criterion (heap plateau and trend against a healthy control, RSS trend, at most two collector connections) is in [backlog/phase-1.md](backlog/phase-1.md), P1-13.
  - The flush and shutdown lift covers exports the batch processor starts synchronously. It relies on Nestrix's resource having no pending async attributes (true today: `defaultResource()` plus synchronous attributes); with an async resource, deferred flush exports would be held to one in flight (P1-03 follow-up review). A timed-out export that then fails is reported to the global error handler twice (once as the processor's timeout, once with the real error); counters are unaffected.
- Buffered spans are flushed when the Nest application closes: `app.close()` runs `onApplicationShutdown`. On `SIGTERM`/`SIGINT` Nest calls `close()` only with `app.enableShutdownHooks()`; the docs recommend it. A host-owned provider is never flushed or shut down by Nestrix.
- Several Nestrix apps in one process share the provider the first one registered (reference-counted). Closing any but the last flushes and leaves everything registered; closing the last flushes and shuts down the provider within the bound (5 s), then removes the globals Nestrix registered, so a later app (an e2e suite) can own them again.
- What can hold the process after the bound. When the bound expires Nestrix fails every export still waiting (so the batch processor clears its export timer, which it clears only on the exporter's callback) and destroys the exporter's sockets with an error the exporter does not retry; later connections fail the same way. The exporter's sockets are unref'ed throughout (a custom agent passed as `httpAgentOptions`; Node's `Agent` re-refs a reused keep-alive socket). What remains: a retry backoff timer the exporter already scheduled (not `unref`ed and not reachable through public API), at most 5 s (`MAX_BACKOFF`), or a collector's `Retry-After` if that fits the exporter's deadline; its attempt then fails at once. Measured with a child process (`otel-shutdown-bound.test.ts`, bound 800 ms, exporter timeout 20 s): a hanging collector exits within 1 s of shutdown resolving (before the fix, after the exporter timeout); a refusing collector within the remaining backoff (about 1.7 s observed).
- A `benchmarks/` workspace runs the same app under four configurations (uninstrumented, headless, with dashboard, upstream auto-instrumentation) and records p50/p99 latency, throughput, CPU, RSS and startup time, plus a run with the OTLP endpoint unreachable. `@nestjs/observe` is not benchmarked; its licence does not clearly permit it.
- Targets are set from the phase 1 baseline and enforced as CI thresholds. Starting hypotheses: level 1 at 100% sampling within 10% of uninstrumented throughput on a trivial route; under 100 ms added startup; RSS growth during an exporter outage bounded by the configured queue and store sizes plus a measured constant.

### 4.10 Standalone server (phase 5)

- One Docker image: a NestJS 12 app, instrumented with Nestrix itself, with an OTLP/HTTP receiver, storage, the query API and the same UI build.
- Receiver: `/v1/traces` first; protobuf and JSON; gzip; 64 MiB limit; partial success; 429/503 with `Retry-After`. Decoding with `@bufbuild/protobuf` and code generated from a pinned `opentelemetry-proto`, checked in. OTLP's JSON form gets its own mapping.
- Storage: PostgreSQL 18 with Drizzle. `spans` partitioned by day, `resources`, and a per-minute rollup per service and route written at ingest. Retention by dropping partitions. Partition DDL in hand-written SQL migrations. Start on Drizzle 0.45; move to 1.0 when it is stable.
- Scope is stated honestly: the supported ingest rate is measured and published. Beyond it, send OTLP to a dedicated backend.
- Ingest authenticated by API key; one admin login for the UI.

## 5. Packages

| Package | Contents |
|---|---|
| `@nestrix/nestjs` | The SDK: module, `NestrixInstrument`, Nest instrumentation, outbound HTTP, the `pg` / `mysql2` / `ioredis` integrations, OpenTelemetry setup, in-memory store, query API, redaction |
| `@nestrix/ui` | Prebuilt dashboard assets only. No runtime dependencies. Optional. Budget: under 1 MB unpacked, enforced in CI. |
| `@nestrix/server` (phase 5) | Standalone collector, storage and UI host. Distributed primarily as a Docker image. |
| `packages/protocol` (private) | Query-API types shared by the SDK, the server and the UI |

One version number for all. An integration becomes its own package only when it needs a heavy or conflicting dependency.

## 6. Frontend

React 19, Vite 8, TypeScript. TanStack Router with hash history; TanStack Query for polling; TanStack Virtual for long span lists. Tailwind 4 with shadcn/ui components copied into the repository. uPlot for time series (Chart.js as fallback). The trace waterfall is built in-house. A static SPA: no server rendering, no framework server. The standalone server serves the same build.

## 7. Developer experience

Phase 1 settled the headless API below (names and shapes are `packages/nestjs/src/options.ts` and `docs/backlog/phase-1.md`, "Public API"); it freezes at 1.0. What the user reads is `packages/nestjs/README.md`. The dashboard, level 2 and library integrations are still illustrative and are marked as such.

```bash
pnpm add @nestrix/nestjs @opentelemetry/api@~1.10.0    # headless: tracing and OTLP export
pnpm add @nestrix/ui                                   # phase 2: dashboard assets
```

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { NestrixModule } from '@nestrix/nestjs';

@Module({ imports: [NestrixModule.forRoot({ serviceName: 'my-api' })] })
export class AppModule {}
```

The module is global. It is imported before other modules that register global interceptors (§4.2, interceptor order). With no endpoint configured nothing is exported, and one log line says so; export is on when `export.otlp.endpoint`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set. The standard `OTEL_*` variables listed in the README are honoured, and `NESTRIX_ENABLED=false` registers nothing.

```ts
// Options from another provider; useFactory may be async.
NestrixModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    serviceName: 'my-api',
    export: { otlp: { endpoint: config.get('COLLECTOR_URL') } },
  }),
});
```

```ts
NestrixModule.forRoot({
  enabled: true,
  serviceName: 'my-api',
  resourceAttributes: { 'deployment.environment.name': 'production' },
  sampleRate: 0.1, // ParentBased(TraceIdRatioBased); ignored when the host owns the SDK
  export: {
    otlp: { endpoint: 'http://otel-collector:4318', headers: {}, timeoutMillis: 10_000 }, // or `otlp: false`
    queue: { maxQueueSize: 2048, maxExportBatchSize: 512, scheduledDelayMillis: 5000 },
  },
  ignore: {
    routes: ['/health', /^\/metrics/],            // a string is the exact path
    outgoing: ['https://o123.ingest.sentry.io/'], // a string is a prefix of url.full
  },
  http: { requestHeaders: [], responseHeaders: [], redactQueryKeys: [] }, // added to the defaults
  redact: (span) => { /* synchronous; return false to drop the span */ },
});
```

```ts
// main.ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks(); // only so SIGTERM and SIGINT close the app; app.close() flushes without it
```

```ts
import { Span, withSpan } from '@nestrix/nestjs';

@Span('billing.reconcile') // default name: Class.method
async reconcile() { /* … */ }

await withSpan('load-rates', (span) => fetchRates());
```

`Span` and `withSpan` are thin wrappers over `@opentelemetry/api`. Code that uses the OpenTelemetry API directly joins the same traces. The promise a traced method returns must be handled by its caller (§4.3).

Not available yet (`ui` and `integrations` are not in `NestrixModuleOptions`, so TypeScript rejects them; the shapes are illustrative):

```ts
// phase 2: the dashboard. Locally at http://localhost:3000/_nestrix; one log line gives the URL or the install command.
NestrixModule.forRoot({ ui: { enabled: true, path: '/_nestrix', auth: { token: process.env.NESTRIX_UI_TOKEN } } });

// level 2 (phase 2): spans for controller methods and jobs
const app = await NestFactory.create(AppModule, { instrument: NestrixInstrument });

// phase 3: library spans; mysql2 and ioredis are opt-in (D-49)
NestrixModule.forRoot({ integrations: { ioredis: true } });

// BullMQ jobs, with BullMQ's own option
BullModule.forRoot({ connection, telemetry: new BullMQOtel('my-api') });
```

## 8. Repository

```
nestrix/
  packages/nestjs/        @nestrix/nestjs
  packages/ui/            @nestrix/ui (dashboard source; publishes dist/ only)
  packages/protocol/      private: query-API types
  apps/server/            phase 5
  examples/               express-esm, fastify-esm, node-esm, express-cjs, microservices
  benchmarks/
  docs/
```

- pnpm workspaces. No Turborepo until CI time justifies it.
- TypeScript 6, `module` and `moduleResolution: nodenext`, legacy decorators with `emitDecoratorMetadata`. The SDK is built with `tsc` only.
- ESM-only output. No top-level `await` in any published entry point, so CommonJS Nest 12 apps can `require()` it. Enforced by `pnpm check:tla` (`scripts/check-no-tla.mjs`, part of `verify`, so it runs on every Node in the CI matrix): it `require()`s each published entry and every built file in a child process. Users of CommonJS projects running Jest need `--experimental-vm-modules` (Nest's own CommonJS starter sets it) and Node 24.9+, or a transform on 22.x; this is how Nest 12 itself loads under Jest.
- Vitest 4. Integration tests boot real Nest apps on all three adapters and assert on spans captured by an in-memory exporter.
- Biome for lint and format. `publint` and `@arethetypeswrong/cli` in CI.
- Changesets with fixed versioning. Publishing from GitHub Actions through npm trusted publishing with provenance.
- CI matrix: Node 22.15, 24, 26 × Nest 12.0 and latest × Express and Fastify, plus platform-node from 12.3.2 (D-44).

## 9. Main risks

| Risk | Mitigation |
|---|---|
| The Nest team's product is in the default starter and they control the hooks. | Compete on what its licence and hosting rule out. Use only public, documented hooks. |
| Nest's hooks are single-slot and recent; behaviour may shift in minors. | A conformance suite against the minimum and latest Nest 12, with a nightly run against `latest`. |
| An embedded dashboard exposes application internals. | Local-only default, fail-closed without `auth`, no CORS, read-only, redaction before storage. |
| Method wrapping changes behaviour (lost metadata, private fields, callable objects). | The requirements in §4.3, a spike before building, and a test corpus of awkward classes. |
| Postgres cannot keep up with a busy fleet. | Publish the measured envelope; recommend a dedicated backend beyond it. |
| OpenTelemetry JS moves fast (SDK 2.0 to 3.0 in about 18 months). | Depend on few SDK packages, pin one SDK generation per minor line, keep instrumentation on the stable API only. |
| Upstream ships Nest 12 support and narrows the gap. | The value does not rest on that gap: no loader flags, deeper Nest coverage, and the dashboard remain. |
| Scope. | Vertical slices; standalone and logs/metrics come after the SDK has users. |
