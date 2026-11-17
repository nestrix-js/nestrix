# Testing your app

## Keep Nestrix off by default

In unit and e2e tests you usually want no dashboard, no export and no global OpenTelemetry state. Set `NESTRIX_ENABLED=false` for the test run (in the test script, or a Vitest/Jest setup file): Nestrix then registers nothing at all. Turn it on only in the tests that assert on spans.

```json
{ "scripts": { "test": "NESTRIX_ENABLED=false vitest run" } }
```

## What runs under `@nestjs/testing`

HTTP server spans, outbound-call spans and your own `withSpan` spans work. Level 2 method spans do not (D-48): Nest gives `Test.createTestingModule` no `instrument` option and no public way to decorate instances there. `@Span()` and `withSpan()` are explicit, so they still produce spans. For method spans from `methods.include`, boot the app with `NestFactory.create` and `instrument: NestrixInstrument` in an e2e test.

## Capturing spans: `@nestrix-js/nestjs/testing`

```ts
import { createInMemorySpanCapture } from "@nestrix-js/nestjs/testing";

const capture = createInMemorySpanCapture();
// capture.spans()            finished spans, oldest first (OpenTelemetry ReadableSpan)
// capture.findSpan("name")   by name, or by predicate: findSpan((s) => s.attributes["x"] === 1)
// capture.reset()            forget what was captured, e.g. in beforeEach
// await capture.shutdown()   unregister; call it in afterAll
```

Rules:

- Call it **before** the Nest app is created, once per test file. It registers a tracer provider with an in-memory exporter, plus a context manager and the W3C propagator, so Nestrix reports through it as it does through any host-owned SDK. If a provider is already registered it throws and says so.
- Run with Nestrix enabled in these tests (leave `NESTRIX_ENABLED` unset, or set it to `true`).
- A server span ends when the response finishes, which can be just after your client has read it. Wait for it (`vi.waitFor`, `await eventually(...)`) instead of asserting on the line after `fetch`.
- The helper imports the OpenTelemetry SDK, so it belongs in test code only. Do not import it from application code.

### Vitest

```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { createInMemorySpanCapture } from "@nestrix-js/nestjs/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { AppModule } from "./app.module.js";

const capture = createInMemorySpanCapture();
let app: Awaited<ReturnType<typeof NestFactory.create>>;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, "127.0.0.1");
});
afterAll(async () => {
  await app.close();
  await capture.shutdown();
});

it("records the route on the server span", async () => {
  const { port } = app.getHttpServer().address();
  await fetch(`http://127.0.0.1:${port}/users/42`);
  await vi.waitFor(() => {
    const span = capture.findSpan((s) => s.attributes["http.route"] === "/users/:id");
    expect(span?.attributes["http.response.status_code"]).toBe(200);
  });
});
```

### Jest

Nestrix and the helper are ESM-only; a CommonJS Jest setup loads them with `require()` on Node 26. Under ESM Jest the imports are the same as in the Vitest example.

```ts
const { NestFactory } = require("@nestjs/core");
const { createInMemorySpanCapture } = require("@nestrix-js/nestjs/testing");
const { AppModule } = require("./app.module");

const capture = createInMemorySpanCapture();
let app;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, "127.0.0.1");
});
afterAll(async () => {
  await app.close();
  await capture.shutdown();
});

test("records the route on the server span", async () => {
  const { port } = app.getHttpServer().address();
  await fetch(`http://127.0.0.1:${port}/users/42`);
  await new Promise((resolve) => setTimeout(resolve, 50)); // or poll with your own helper
  const span = capture.findSpan((s) => s.attributes["http.route"] === "/users/:id");
  expect(span.attributes["http.response.status_code"]).toBe(200);
});
```
