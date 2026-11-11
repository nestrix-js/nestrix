// Boots a trivial Nest 12 app that has the packed Nestrix packages installed, as a CommonJS
// consumer. The Nestrix packages are ESM-only, so require() loads them through require(esm).
// The root module imports NestrixModule.forRoot, so the ESM package's decorated provider is
// constructed with its injected options inside a CommonJS app.
// Plain JavaScript: decorators are applied as functions, so there is no TypeScript build step.
require("reflect-metadata");
const assert = require("node:assert/strict");
const { Controller, Get, Module } = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");
const { NestrixModule } = require("@nestrix-js/nestjs");
const { dashboardDirectory } = require("@nestrix-js/ui");

assert.equal(typeof NestrixModule.forRoot, "function");
assert.ok(dashboardDirectory instanceof URL);

const SERVICE_NAME = "consume-cjs";
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

async function main() {
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
    console.log(`cjs fixture: options ok (${SERVICE_NAME}), GET / -> 200`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
