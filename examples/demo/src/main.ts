import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { NestrixInstrument } from "@nestrix-js/nestjs";
import { AppModule } from "./app.module.js";
import { seed } from "./db.js";

await seed();
const app = await NestFactory.create(AppModule, {
  instrument: NestrixInstrument,
});
const port = Number(process.env.PORT ?? 3000);
await app.listen(port, "127.0.0.1");

// Traffic, so the dashboard has something to show. Requests come from outside any trace,
// so each one is a new root trace of the app.
const base = `http://127.0.0.1:${port}`;
const paths = [
  "/orders",
  "/orders",
  "/orders/7",
  "/orders/999",
  "/quote",
  "/reports/revenue",
  "/archive",
];
const users = ["u-ada", "u-grace", "u-linus"];
let i = 0;
setInterval(() => {
  const path = paths[i % paths.length];
  const user = users[i % users.length];
  i++;
  fetch(base + path, { headers: { "x-demo-user": user } })
    .then((r) => r.text())
    .catch(() => {});
}, 700).unref();
