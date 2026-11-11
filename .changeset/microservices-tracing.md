---
"@nestrix-js/nestjs": minor
"@nestrix-js/ui": minor
---

Microservice tracing: SERVER spans for `@MessagePattern` and CONSUMER spans for `@EventPattern` handlers, parented on the trace context carried in the packet metadata (TCP, Redis, NATS, RabbitMQ, Kafka, MQTT 5); CLIENT spans for `send` and PRODUCER spans for `emit` on `ClientsModule` clients, with the trace context injected through the client's dispatch hook. `instrumentClient(client)` instruments a client created outside dependency injection, and `nestrixPreRequestHook` gives handler spans in a hybrid app (`connectMicroservice(options, { deferInitialization: true }).registerPreRequestHook(nestrixPreRequestHook)`).
