// Boots the standalone server's real app (admin login, UI, query API) with the in-memory ingest
// sink, so no PostgreSQL is needed. Used by server-login.pw.ts; prints the port when listening.
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../apps/server/dist/app.module.js";
import { configureApp } from "../../apps/server/dist/bootstrap.js";
import { loadConfig } from "../../apps/server/dist/config.js";

const result = loadConfig({
  DATABASE_URL: "postgres://localhost:5432/unused",
  NESTRIX_INGEST_AUTH: "none",
  NESTRIX_ADMIN_PASSWORD: process.env.E2E_ADMIN_PASSWORD,
});
if (!result.ok) throw new Error(result.errors.join("\n"));
const app = await NestFactory.create(
  AppModule.forRoot(result.config, { inMemory: true }),
  {
    bodyParser: false,
    logger: false,
  },
);
configureApp(app, result.config);
await app.listen(0, "127.0.0.1");
console.log(`PORT=${app.getHttpServer().address().port}`);
