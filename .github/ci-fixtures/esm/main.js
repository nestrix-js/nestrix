// Boots a trivial Nest 12 app that has the packed Nestrix packages installed, as an ESM consumer.
// Plain JavaScript: decorators are applied as functions, so there is no TypeScript build step.
import "reflect-metadata";
import assert from "node:assert/strict";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NESTRIX_PACKAGE } from "@nestrix/nestjs";
import { dashboardDirectory } from "@nestrix/ui";

assert.equal(NESTRIX_PACKAGE, "@nestrix/nestjs");
assert.ok(dashboardDirectory instanceof URL);

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
Module({ controllers: [AppController] })(AppModule);

const app = await NestFactory.create(AppModule, { logger: ["error"] });
await app.listen(0, "127.0.0.1");
try {
  const { port } = app.getHttpServer().address();
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  console.log("esm fixture: GET / -> 200");
} finally {
  await app.close();
}
