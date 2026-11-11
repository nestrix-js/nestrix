// Boots a trivial Nest 12 app that has the packed Nestrix packages installed, as an ESM consumer.
// The root module imports NestrixModule.forRoot, so the decorated provider is constructed with
// its injected options.
// Plain JavaScript: decorators are applied as functions, so there is no TypeScript build step.
import "reflect-metadata";
import assert from "node:assert/strict";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestrixModule } from "@nestrix-js/nestjs";
import { dashboardDirectory } from "@nestrix-js/ui";

assert.equal(typeof NestrixModule.forRoot, "function");
assert.ok(dashboardDirectory instanceof URL);

const SERVICE_NAME = "consume-esm";
const OPTIONS_TOKEN = Symbol.for("@nestrix-js/nestjs:options");

class AppController {
  hello() {
    return "ok";
  }
}
Controller()(AppController);
Get("/")(
  AppController.prototype,
  "hello",
  Object.getOwnPropertyDescriptor(AppController.prototype, "hello"),
);

class AppModule {}
Module({
  imports: [NestrixModule.forRoot({ serviceName: SERVICE_NAME })],
  controllers: [AppController],
})(AppModule);

const app = await NestFactory.create(AppModule, { logger: ["error"] });
try {
  const options = app.get(OPTIONS_TOKEN);
  assert.ok(options !== null && typeof options === "object");
  assert.equal(options.serviceName, SERVICE_NAME);
  assert.equal(options.enabled, true);

  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address();
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  console.log(`esm fixture: options ok (${SERVICE_NAME}), GET / -> 200`);
} finally {
  await app.close();
}
