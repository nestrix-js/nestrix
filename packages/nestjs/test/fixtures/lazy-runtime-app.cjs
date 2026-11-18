// Child process for test/methods/switched-off.test.ts (D-99, #41): a CommonJS Nest app that loads
// the built @nestrix-js/nestjs with require() and lets Nestrix own the provider, so the SDK and the
// exporter come from the lazily loaded runtime. It serves exactly one request, the first, then
// closes the app (which flushes the export) and prints one JSON line.
//
// argv[2]: the OTLP base endpoint of the test's receiver. argv[3]: "async" for forRootAsync.
require("reflect-metadata");
const {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
} = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");
const { NestrixModule, NestrixInstrument } = require("../../dist/index.js");

class HelloService {
  greet() {
    return "hello";
  }
}
Injectable()(HelloService);

class HelloController {
  constructor(service) {
    this.service = service;
  }
  hello() {
    return this.service.greet();
  }
}
Inject(HelloService)(HelloController, undefined, 0);
Controller()(HelloController);
Get("hello")(
  HelloController.prototype,
  "hello",
  Object.getOwnPropertyDescriptor(HelloController.prototype, "hello"),
);

const options = {
  serviceName: "lazy-runtime",
  ui: false,
  metrics: false,
  export: {
    otlp: { endpoint: process.argv[2] },
    queue: { scheduledDelayMillis: 60_000 },
  },
};
const nestrix =
  process.argv[3] === "async"
    ? NestrixModule.forRootAsync({ useFactory: async () => options })
    : NestrixModule.forRoot(options);

class AppModule {}
Module({
  imports: [nestrix],
  controllers: [HelloController],
  providers: [HelloService],
})(AppModule);

async function main() {
  const app = await NestFactory.create(AppModule, {
    logger: false,
    instrument: NestrixInstrument,
  });
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address();
  const res = await fetch(`http://127.0.0.1:${port}/hello`);
  const body = await res.text();
  await app.close();
  process.stdout.write(`${JSON.stringify({ status: res.status, body })}\n`);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
