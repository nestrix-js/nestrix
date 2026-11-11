// Boots a trivial Nest 12 app that has the packed Nestrix packages installed, as a CommonJS
// consumer. The Nestrix packages are ESM-only, so require() loads them through require(esm).
// Plain JavaScript: decorators are applied as functions, so there is no TypeScript build step.
require("reflect-metadata");
const assert = require("node:assert/strict");
const { Controller, Get, Module } = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");
const { NESTRIX_PACKAGE } = require("@nestrix/nestjs");
const { dashboardDirectory } = require("@nestrix/ui");

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

async function main() {
  const app = await NestFactory.create(AppModule, { logger: ["error"] });
  await app.listen(0, "127.0.0.1");
  try {
    const { port } = app.getHttpServer().address();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    console.log("cjs fixture: GET / -> 200");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
