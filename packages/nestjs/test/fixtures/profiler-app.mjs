// Child process for profiler-acceptance.test.ts (P7-02): a plain-JavaScript Nest app (decorators
// applied as functions, as in spikes/p7-s1/fixtures/app.mjs) with the built @nestrix/nestjs and
// the dashboard on (`enabled: true` with a token). One fresh process per adapter, because a CPU
// profile covers the whole process and code transformed by Vitest has no real file URL.
//
// argv[2]: express | fastify | node. Prints one JSON line `{ "port": n }` when listening.
// Routes: GET /hello (trivial), GET /cpu (about 1 ms of JavaScript in `hotRouteWork`).
import "reflect-metadata";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestrixModule } from "../../dist/index.js";

export const TOKEN = "p".repeat(40);

// biome-ignore format: one line, so the profile's line number is easy to check (line 17)
export function hotRouteWork(n) { let x = 0; for (let i = 0; i < n; i++) x += Math.sqrt(i) * Math.sin(i); return x; }

class AppController {
  hello() {
    return "hello";
  }
  cpu() {
    return String(hotRouteWork(60_000));
  }
}
Controller()(AppController);
for (const name of ["hello", "cpu"]) {
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
      serviceName: "profiler-acceptance",
      export: { otlp: false },
      ui: { enabled: true, auth: { token: TOKEN } },
    }),
  ],
  controllers: [AppController],
})(AppModule);

// The platform packages are dependencies of @nestrix/testing (one pnpm peer set, one @nestjs/core).
const fromTesting = createRequire(
  fileURLToPath(import.meta.resolve("@nestrix/testing")),
);
const PLATFORM = {
  express: ["@nestjs/platform-express", "ExpressAdapter"],
  fastify: ["@nestjs/platform-fastify", "FastifyAdapter"],
  node: ["@nestjs/platform-node", "NodeAdapter"],
};
const [pkg, name] = PLATFORM[process.argv[2] ?? "express"];
const platform = await import(pathToFileURL(fromTesting.resolve(pkg)).href);

const app = await NestFactory.create(AppModule, new platform[name](), {
  logger: ["error", "warn"],
});
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
