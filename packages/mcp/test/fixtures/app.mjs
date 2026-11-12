// Child process for embedded.test.ts: a plain-JavaScript Nest app (decorators applied as
// functions) with the built @nestrix-js/nestjs and the dashboard on (`enabled: true` with a
// token), listening on a free loopback port. A fresh process, because a CPU profile covers the
// whole process and code transformed by Vitest has no real file URL.
//
// Prints one JSON line `{ "port": n }` when listening; the message "close" shuts it down.
// Routes: GET /hello, GET /orders (an N+1: the same statement five times, then a slower one,
// with a method span per call), GET /boom (throws), GET /cpu (CPU-bound `hotRouteWork`).
import "reflect-metadata";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestrixModule, withSpan } from "@nestrix-js/nestjs";

export const TOKEN = process.env.APP_DASHBOARD_TOKEN ?? "e".repeat(40);
const CLIENT = 2; // SpanKind.CLIENT

// biome-ignore format: one line, so the profile's line number is easy to check
export function hotRouteWork(n) { let x = 0; for (let i = 0; i < n; i++) x += Math.sqrt(i) * Math.sin(i); return x; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function query(name, text, ms) {
  return withSpan(
    name,
    async () => {
      await sleep(ms);
    },
    {
      kind: CLIENT,
      attributes: { "db.system.name": "postgresql", "db.query.text": text },
    },
  );
}

class AppController {
  hello() {
    return "hello";
  }
  async orders() {
    for (let i = 0; i < 5; i++) {
      await query("SELECT users", "SELECT * FROM users WHERE id = $1", 2);
    }
    await query("SELECT orders", "SELECT * FROM orders WHERE open", 60);
    return "orders";
  }
  boom() {
    throw new Error("kaboom from the fixture");
  }
  cpu() {
    return String(hotRouteWork(60_000));
  }
}
Controller()(AppController);
for (const name of ["hello", "orders", "boom", "cpu"]) {
  Get(name)(
    AppController.prototype,
    name,
    Object.getOwnPropertyDescriptor(AppController.prototype, name),
  );
}

class AppModule {}
Module({
  imports: [
    NestrixModule.forRoot({
      serviceName: "mcp-embedded-fixture",
      export: { otlp: false },
      ui: { enabled: true, auth: { token: TOKEN } },
    }),
  ],
  controllers: [AppController],
})(AppModule);

const app = await NestFactory.create(AppModule, { logger: false });
await app.listen(0, "127.0.0.1");
process.stdout.write(
  `${JSON.stringify({ port: app.getHttpServer().address().port })}\n`,
);
process.on("message", async (message) => {
  if (message === "close") {
    await app.close();
    process.exit(0);
  }
});
