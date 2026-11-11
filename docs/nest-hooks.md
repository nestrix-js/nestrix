# NestJS 12 extension points Nestrix builds on

Read from the NestJS source (`nestjs/nest`, `master`, the 12.x line) on 2026-11-11. Phase 0 spikes (P0-S1, P0-S5, P0-S6; results in `docs/spikes/`) then ran what follows on Nest 12.0.0, 12.3.x and 12.4.2; statements they confirmed or corrected cite them. Anything still marked **spike** is unproven. Paths are relative to `packages/` in the Nest repository.

## 1. Bootstrap order

`NestFactory.create()` (`core/nest-factory.ts`):

1. `container.setHttpAdapter(httpServer)`
2. `instanceLoader.createInstancesOfDependencies()`: every provider is constructed here.
3. `new NestApplication(...)`, whose constructor calls `registerHttpServer()` and so `httpAdapter.initHttpServer()`.

`app.init()` (`core/nest-application.ts`), called by `listen()`:

1. `httpAdapter.init()`, body-parser registration
2. `registerModules()` (middleware)
3. `registerRouter()`: all controller routes are registered
4. `callInitHook()`: `onModuleInit`
5. `registerRouterHooks()`: the not-found handler and the exception handler
6. `callBootstrapHook()`: `onApplicationBootstrap`

What follows from that:

- Under `NestFactory.create`, the adapter exists when providers are constructed, so a provider constructor can call adapter setters.
- Routes are registered **before** `onModuleInit`. Anything that must be in place when routes are registered (`setOnRouteTriggered`) has to be set at construction.
- A route added in `onModuleInit` lands after the host's routes and before the not-found handler. A route added in `onApplicationBootstrap` lands after the not-found handler, which on Express makes it unreachable when there is no global prefix.
- A provider constructor runs before `initHttpServer`. Despite the platform-node adapter's comments, registering routes from a constructor works on all three adapters; the effect is ordering: such routes land before the host's middleware and routes (P0-S5).
- Apps without HTTP: `HttpAdapterHost.httpAdapter` is **`null` or `undefined`, and `init$` may never emit**. It is `null` under `NestFactory.createMicroservice` and `createApplicationContext` (where `init$` emits `null`), and `undefined` under `@nestjs/testing`'s `createNestMicroservice()` and for a compiled testing module never turned into an app (where `init$` never emits). Test truthiness; never wait on `init$` (P0-S1).
- Under `@nestjs/testing` the adapter is `undefined` in provider constructors (12.0.0 and 12.4.2). It is set at the start of `createNestApplication()`, before `app.init()`.
- `HttpAdapterHost.init$` is public (`@publicApi`, `helpers/http-adapter-host.d.ts`) and emits from the `httpAdapter` setter, i.e. when the adapter is **set**, which is before routes are registered under both `NestFactory` and `@nestjs/testing`. Hooks set from an `init$` subscription made in a constructor therefore work, `setOnRouteTriggered` included (P0-S1, P0-S5). Two conditions: its JSDoc says it emits "when the HTTP application is initialized", so this relies on the code, not the comment (a nightly test on the latest 12.x guards it); and a subscriber runs inside Nest's setter, where a throw is rethrown by RxJS asynchronously as `uncaughtException` and kills a process with no handler, so the subscriber's entire body must catch everything.

## 2. HTTP adapter hooks

Declared on `AbstractHttpAdapter` (`core/adapters/http-adapter.ts`), documented there as "intended for instrumentation and devtools". All three built-in adapters implement them. Each is a **single slot**: a second caller replaces the first.

```ts
setOnRequestHook(hook: (req, res, done: (err?: Error) => void) => void | Promise<void>): void
setOnResponseHook(hook: (req, res) => void | Promise<void>): void
setOnRouteTriggered(hook: (requestMethod: RequestMethod, path: string) => void): void
getOnRouteTriggered(): typeof hook | undefined     // the only one with a getter
```

### Request hook

| | Express | Fastify | platform-node |
|---|---|---|---|
| Where it runs | First middleware, added in the adapter constructor | First `onRequest` hook, added in the adapter constructor | First middleware |
| Read when | Per request (`if (this.onRequestHook)`), so it can be set late | Per request | Per request |
| How the request continues | Only by calling `done()`. A resolved promise does not continue it. | `done()`, or a resolved promise from 12.1.3 (before that, only `done()`) | Only `done()` |
| If the hook throws | From 12.1.3: a throw before `done()` becomes `done(err)` once, **the user's request fails** (500, no guard or handler runs); a throw after `done()` is logged. Before 12.1.3 there is no guard: a throw after `done()` also gives a 500 though the handler ran | Same; a throw after `done()` is dropped | Same as Express |
| Runs for 404s | Yes | Yes | Yes |
| Requests that skip it | A host-supplied server instance's own middleware, which runs first and outside the store | Malformed percent-encoding (400) and a parameter over `maxParamLength`, default 100 (414); a host-supplied instance's own `onRequest` hooks | — |

On every adapter, whatever Node's HTTP parser rejects (bad header name 400, headers over 16 KiB 431, a target without a leading slash 400) never reaches the hook. Inferred, not run: Node's `requestTimeout` / `headersTimeout`, `upgrade` and `CONNECT`, and `Expect: 100-continue` with a `checkContinue` listener. (P0-S1.)

Rules for Nestrix's hook, which follow directly:
- Write it as a synchronous function that calls `done()` exactly once, on every path.
- Wrap the whole body so nothing can throw into `done(err)`.
- Call `done()` inside the span's context (`context.with(ctx, done)`). `done` continues the pipeline synchronously, so everything downstream inherits the context. The context survives body parsing (JSON, multipart, multer, bodies arriving in later packets) on Express and Fastify from 12.0.0 and on platform-node from 12.3.2; platform-node 12.3.0 loses it after the JSON parser, and 12.3.1 does by its source (P0-S1, run on 12.0.0, 12.3.0, 12.3.2 and 12.4.2, 50 concurrent requests, Node 24 and 26 with and without AsyncContextFrame).

### Response hook

Do not use it. On Express and platform-node it is attached to the response's `finish` event only, so it never fires for a client abort. On Fastify it is an `onResponse` hook that completes only on `done()`, a settled promise or a throw, so a plain synchronous `(req, res) => void` hook leaves the chain hanging.

Instead: in the request hook, attach a `close` listener to the raw `ServerResponse` (`res` on Express and platform-node, `reply.raw` on Fastify) and end the span there. `close` fires exactly once for finished and aborted responses alike (P0-S1: 200, 404, 403, 500, 418, a stream, three kinds of abort, all three adapters). This also leaves one fewer single-slot hook to contend for.

Reading the outcome at `close` (P0-S1): `headersSent` true means `statusCode` is what was sent; `writableEnded && !writableFinished` means the app finished but delivery was cut; `!headersSent && !writableFinished` means no response was sent, so record no status code (`statusCode` still reads 200 there). When the client goes away the listener runs **outside** the request's async context, so it must hold its span itself.

### Route-triggered hook

- Captured when routes are registered (`core/router/router-explorer.ts`), so it must be set before `app.init()`: at provider construction.
- Fires right before the route handler proxy runs, which is before guards.
- Receives `(requestMethod, path)` where `path` is the declared route path before `normalizePath`, built by the route path factory (composition, P0-S1: global prefix, then `/v<version>` under URI versioning, then controller path and method path, leading slash, parameters as declared; header versioning puts no version in the path).
- Receives **no request object**. Finding the active server span depends entirely on async context.
- It wraps the version and host filters, so it fires before any of them can decline. Under header versioning on Express and platform-node it fires once per handler tried, and still fires for a request that ends in a 404 because no version matched. A declining handler has the same path as the one that accepts, so the last value is right whenever some handler accepts. On Fastify it fires only for the matched route. Fires before guards (also for a guard-rejected route); the store is readable inside it (P0-S1).
- Does not fire for unmatched requests. A 404 span is named by method only (`GET`), with `http.route` unset, as the OpenTelemetry HTTP conventions require.
- It has a getter, so chain what is already there: `const prev = adapter.getOnRouteTriggered?.()`.

### Sharing the slots

`setOnRequestHook` and `setOnResponseHook` have no getters; the fields are private. Chaining a previous request hook is not possible through public API. Nestrix therefore states plainly that only one hook-based APM can run in a process, checks at bootstrap whether another one is installed, and logs a clear warning.

## 3. Generic route and response methods

All three adapters implement `get`, `post`, `all`, `use`, `reply(res, body, status?)`, `status`, `end`, `setHeader(res, name, value)`, `isHeadersSent`, `getRequestUrl(req)`, `getRequestMethod(req)`, `getRequestHostname(req)`, `getType()`.

Routes added through `httpAdapter.get(path, handler)` bypass the Nest pipeline: no global prefix, versioning, guards, pipes, interceptors or filters. `@nestjs/swagger` serves its UI this way. What host-level middleware still applies differs:

| | Express | Fastify | platform-node |
|---|---|---|---|
| Host `app.use()` middleware | Only middleware registered earlier | All of it, including middleware added after `listen()` | Only middleware registered earlier |
| `enableCors()` | `use(cors())` when called, so it covers routes added later (the `cors` factory option is applied at the start of `init()`: read from source) | An `onRequest` hook covering every route; with `hook` other than `onRequest` it runs after the handler and only hijacking avoids it | `use(cors())` when called |
| Order-sensitive routing | Yes: an earlier catch-all route shadows later routes | No (matched by specificity) | Partly: specificity within a contiguous run of routes, registration order across runs separated by any `use()` (`isRouteOrderSensitive()` returning `false`: read from source) |
| Late route registration | Works until the not-found handler is added | Works until `ready`; nothing calls `ready` before `listen` | Works from `onModuleInit` (from `onApplicationBootstrap`: not tested) |
| Exception thrown or rejected by the handler | Reaches Nest's exception handler and the host's global filters | Same | Same |
| `reply()` / `end()` | `httpAdapter.reply(res, buffer)` JSON-encodes a `Buffer` | `httpAdapter.end()` bypasses the reply's headers; hijacked replies still run host `onResponse` hooks | — |

(All rows: spike P0-S5, run on 12.4.2 unless marked.) `app.getHttpAdapter()` is typed `HttpServer`, which does not declare `setOnRequestHook`; `HttpAdapterHost.httpAdapter` is typed `AbstractHttpAdapter`, which does.

Consequences for the dashboard are in [architecture.md](architecture.md#46-embedded-dashboard).

## 4. The `instrument` option

```ts
NestFactory.create(AppModule, { instrument: { instanceDecorator: (instance: unknown) => unknown } })
```

Also accepted by `createMicroservice` and `createApplicationContext`. Present from `@nestjs/common` 11.1.4.

Where it is applied (`core/injector/injector.ts`, `instantiateClass`):
- Right after `new Class(...deps)`, **before** property injection. The return value replaces the instance.
- Providers, controllers, guards, interceptors, pipes, filters and class middleware all pass through it.
- Request-scoped and transient instances pass through it on every creation.
- Factory providers: the awaited return value passes through it, whatever it is.
- Value providers do not.
- Plain middleware functions given to `app.use()` and user-constructed global enhancers are passed through it as well.
- Nest wraps the decorator (`makeSafeInstanceDecorator`): if it throws, Nest logs a warning and uses the undecorated instance.

What it does **not** tell you: the hook receives one `unknown` value. No token, no module, no role. "Is this a framework class?" cannot be answered from the hook's arguments alone.

Hazards when wrapping methods, each a requirement on the implementation:

| Hazard | Requirement |
|---|---|
| Nest reads route and enhancer metadata (`@UseGuards`, `@HttpCode`, custom `Reflector` keys) off the handler **function object**, and for request-scoped controllers reads the handler from the instance. A wrapper without that metadata makes a method-level guard invisible: it fails open. | Copy every reflect-metadata key, own properties, `name` and `length` from the original to the wrapper. Test: a route with a method-level guard still returns 403 with instrumentation on. |
| `Proxy` breaks classes with `#private` members and built-ins with internal slots, and changes `this` identity. | No `Proxy`. Wrap methods so the receiver stays the raw instance. |
| Request-scoped instances are created per request. | Cache wrappers per class, not per instance. |
| Functions and non-class values pass through the hook. A variadic wrapper changes `length`, which Express uses to recognise error middleware. | Return functions and non-class values untouched. |
| Callable objects stored in fields (a Mongoose model, an Axios instance) are not methods. | Wrap prototype methods only, never own properties that happen to be callable. |

Deciding what to wrap by default is a **spike** (allowlist by Nest's `@Controller` / `@Injectable` markers plus user `include` / `exclude`, against a denylist of framework classes).

## 5. Microservices

```ts
// @nestjs/microservices 12.0.4+
type PacketMetadata = Record<string, string>
interface ReadPacket<T = any> { pattern: any; data: T; metadata?: PacketMetadata }

class ClientProxy {
  setOnDispatchHook(hook: (packet: ReadPacket) => void): void   // single slot; may assign packet.metadata
}
class Server {
  setOnProcessingStartHook(hook: (transportId, context: unknown, done: () => Promise<any>) => void): void
  setOnProcessingEndHook(hook: (transportId, context: unknown) => void): void
}
```

- The dispatch hook runs once per outgoing packet, requests and events alike, when the packet is created. It can inject context. It **cannot time a span**: there is no end hook on the client. A client span needs `send` / `emit` wrapped on the client instance.
- Metadata travels inside the packet on TCP and Redis, and as headers on NATS, Kafka, RabbitMQ, MQTT 5 and gRPC. On the header transports, a header set on the record or in client options wins over a metadata entry with the same name. MQTT 3 carries none.
- Reading it on the server: `TcpContext.getMetadata()` and `KafkaContext.getMetadata()` exist; the other transport contexts mention metadata and need checking per transport. `BaseRpcContext` has no `getMetadata`.
- `registerPreRequestHook((ctx, next) => Observable)` exists on a microservice instance, runs before guards, and must be registered before the microservice initialises. In a hybrid app `connectMicroservice()` initialises immediately unless `deferInitialization: true` is passed. It is not a method of `NestApplication`.
- `connectMicroservice` uses a fresh application config unless `inheritAppConfig` is set, so whether a module-registered global interceptor reaches microservice handlers in a hybrid app is a **spike** in phase 4.
- `ClientProxy` instances registered through `ClientsModule` are providers and can be found with `DiscoveryService`. Clients created with `ClientProxyFactory.create()` outside dependency injection cannot; they need an explicit helper.

## 6. What is deliberately not used

- `@nestjs/core/internal`: marked internal. Not imported.
- Patching `RouterExecutionContext`, `NestFactoryStatic` or any other Nest internal, which is what the upstream OpenTelemetry instrumentation does.
- A global exception filter: it would change which filter handles the host's exceptions.
- A second Nest application for the dashboard: `Logger.overrideLogger` is static and would affect the host.
