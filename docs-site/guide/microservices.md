# Microservices

With `@nestjs/microservices` installed, Nestrix traces messages in both directions and connects them to the request that sent them. The trace context travels in the message's metadata: inside the packet for TCP and Redis, in headers for NATS, RabbitMQ, Kafka and MQTT 5.

- **Handler spans.** A `@MessagePattern` handler gets a `SERVER` span and an `@EventPattern` handler a `CONSUMER` span, named `<transport> <pattern>` (`tcp sum`, `kafka orders.created`), with `messaging.system`, `messaging.destination.name` and `messaging.operation.type = "process"`. The span is a child of the caller's span when the message carries trace context.
- **Client spans.** `send` gets a `CLIENT` span per subscription and `emit` a `PRODUCER` span, and Nestrix adds the trace context to the outgoing packet. With no active span there is no span and no metadata.
- **No setup** for clients registered through `ClientsModule`, for microservice-only apps (`NestFactory.createMicroservice`), or for a hybrid app whose microservice is connected with `inheritAppConfig: true`.

## Hybrid apps

By default `app.connectMicroservice(options)` gives the microservice its own configuration, which does not include the global interceptor `NestrixModule` registers, so its handlers get no span. One line fixes that:

```ts
const app = await NestFactory.create(AppModule);
app
  .connectMicroservice(
    { transport: Transport.TCP, options: { port: 4000 } },
    // Defers listener registration so the hook below is set in time.
    { deferInitialization: true },
  )
  .registerPreRequestHook(nestrixPreRequestHook);
await app.startAllMicroservices();
await app.listen(3000);
```

A message that both the hook and the interceptor see is traced once.

## Clients outside dependency injection

A client built with `ClientProxyFactory.create()` or `new ClientTCP()` is not found automatically. Wrap it; `instrumentClient` returns the same client:

```ts
export const client = instrumentClient(
  ClientProxyFactory.create({
    transport: Transport.TCP,
    options: { host: "localhost", port: 4000 },
  }),
);
```

A client has one dispatch-hook slot, and Nest offers no public way to read it. If another tool already set one, Nestrix keeps it, injects no trace context for that client and logs one line; the client still gets spans.

## Transports

Tested end to end with real brokers, as one connected trace across an HTTP request, a `send` and an `emit`: TCP, Redis, NATS, RabbitMQ, Kafka and MQTT 5.

- **MQTT 3** has no header channel, so handler spans there start new traces.
- **gRPC** was not tested. Its clients have no `send` or `emit`, so they get no client span, and its handler spans are roots.
- A custom transport is traced but named `rpc <pattern>` with no `messaging.system`. Kafka's `emitBatch` injects context but gets no span.

A trace that a message handler starts shows in the dashboard's request list as type `other`, not `http`. Upstream `@opentelemetry/instrumentation-*` packages (Kafka, AMQP, MongoDB, gRPC) use the same API and join the same traces; set them up as their documentation says.
