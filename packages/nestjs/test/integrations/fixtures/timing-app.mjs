// D-50 timing fixture, ESM app (see timing-shared.cjs). Plain `node`, no flags.
// argv: <orm entry path> <eager|factory|request>. env: PG_HOST, PG_PORT.
// Nestrix comes from this package's built `dist` through the package's own name.
import "reflect-metadata";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const [ormPath, mode] = process.argv.slice(2);
const loadOrm = () => import(pathToFileURL(ormPath).href);
// Import time: the ORM (and its nested `pg`) loads before the app module exists.
const eagerOrm = mode === "eager" ? await loadOrm() : undefined;

const common = await import("@nestjs/common");
const core = await import("@nestjs/core");
const platform = await import("@nestjs/platform-express");
const api = await import("@opentelemetry/api");
const sdk = await import("@opentelemetry/sdk-trace");
const contextManager = await import("@opentelemetry/context-async-hooks");
const otelCore = await import("@opentelemetry/core");
const nestrix = await import("@nestrix-js/nestjs");
const { pgStatus } = await import("../../../dist/integrations/pg.js");
const { run } = createRequire(import.meta.url)("./timing-shared.cjs");

await run({
  common,
  core,
  platform,
  nestrix,
  api,
  sdk,
  contextManager,
  otelCore,
  pgStatus,
  loadOrm,
  eagerOrm,
  mode,
  pgConfig: {
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: "postgres",
    database: "nestrix",
    max: 1,
  },
});
