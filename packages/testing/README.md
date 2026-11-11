# @nestrix/testing

Private test harness (never published). Boots a Nest app on Express, Fastify or `@nestjs/platform-node` and captures finished spans in memory.

```ts
import { bootApp } from "@nestrix/testing";

const booted = await bootApp("fastify", {
  module: MyModule,                 // default: fixture AppModule from examples/express-esm
  testing: true,                    // build via Test.createTestingModule(...).compile()
  configure: (app) => app.setGlobalPrefix("api"), // runs before init/listen
});
const res = await fetch(`${booted.baseUrl}/api/hello`); // http://127.0.0.1:<port>
await booted.waitForSpan("some span", { timeoutMs: 2000 });
booted.spans();                     // finished spans since this app booted
await booted.close();               // closes the app, force-flushes, resets the exporter
```

- `moduleOptions` is stored on the result and not interpreted. It is the slot for the future `NestrixModule.forRoot()` options.
- Fastify gets the same multipart pass-through parser as `examples/fastify-esm`.
- Listens on port 0 at 127.0.0.1; `baseUrl` is read from the bound address.

## One app at a time

OpenTelemetry globals are per process, so there is one in-memory exporter, registered once as the global tracer provider (SDK 3: `TracerProvider`, `SimpleSpanProcessor`, `InMemorySpanExporter` from `@opentelemetry/sdk-trace`). `bootApp` throws if another app is still open: always `await close()` (use `try/finally`). Vitest runs each test file in its own worker, so files do not interfere with each other. Inside a file, run tests sequentially.

The provider has no context manager, so nothing propagates context across `await` yet. A spike that needs that registers its own.

## Decorated classes in test files

Nest needs `design:paramtypes` to inject constructor parameters, and that is emitted only by a compiler that implements `emitDecoratorMetadata`. esbuild does not. Vitest 4 on Vite 8 transforms TypeScript with oxc, which does implement it, **but only when the nearest `tsconfig.json` has `experimentalDecorators` and `emitDecoratorMetadata` on**. Without them DI fails with "can't resolve dependencies".

So no SWC plugin is used. The requirement is: any package or spike that defines Nest classes in `.ts` files run by Vitest has a `tsconfig.json` extending `tsconfig.base.json` that includes those files. `test/decorator-metadata.test.ts` defines a service and a controller in a test file and fails if this stops holding. Checked on 2026-11-11 with Vitest 4.1.12 / Vite 8.3.7: it passes as shipped and fails (`design:paramtypes` is `undefined`) with `emitDecoratorMetadata` set to false.
