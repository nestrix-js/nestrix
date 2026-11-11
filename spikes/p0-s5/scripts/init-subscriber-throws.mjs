// What happens when an HttpAdapterHost.init$ subscriber throws (review item 5).
// Run in a child process by test/r4-init-subscriber.test.ts; prints one JSON line.
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";

const mode = process.argv[2]; // "factory" | "testing"
const events = [];
if (process.argv[3] !== "nohandler")
  process.on("uncaughtException", (e) => {
    events.push(`uncaughtException: ${e.message}`);
  });

class Mount {
  constructor(host) {
    host.init$.subscribe(() => {
      throw new Error("init$ subscriber threw");
    });
  }
}
class AppModule {}
Module({
  providers: [
    {
      provide: "M",
      useFactory: (h) => new Mount(h),
      inject: [HttpAdapterHost],
    },
  ],
})(AppModule);

let boot = "ok";
let app;
try {
  if (mode === "testing") {
    const ref = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = ref.createNestApplication(new ExpressAdapter(), { logger: false });
  } else {
    app = await NestFactory.create(AppModule, new ExpressAdapter(), {
      logger: false,
      abortOnError: false,
    });
  }
  await app.listen(0, "127.0.0.1");
} catch (e) {
  boot = `rejected: ${e.message}`;
}
await new Promise((r) => setTimeout(r, 100));
await app?.close().catch(() => {});
console.log(JSON.stringify({ mode, boot, events }));
