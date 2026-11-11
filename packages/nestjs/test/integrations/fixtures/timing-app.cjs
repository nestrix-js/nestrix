// D-50 timing fixture, CommonJS app (see timing-shared.cjs). Plain `node`, no flags.
// argv: <orm entry path> <eager|factory|request>. env: PG_HOST, PG_PORT.
// Everything is loaded with require(); Nest 12 and Nestrix are ESM, so that is require(esm).
"use strict";
require("reflect-metadata");

const [ormPath, mode] = process.argv.slice(2);
const loadOrm = () => require(ormPath);
// Import time: the ORM (and its nested `pg`) loads before the app module exists.
const eagerOrm = mode === "eager" ? loadOrm() : undefined;

const { run } = require("./timing-shared.cjs");

run({
  common: require("@nestjs/common"),
  core: require("@nestjs/core"),
  platform: require("@nestjs/platform-express"),
  nestrix: require("@nestrix-js/nestjs"),
  api: require("@opentelemetry/api"),
  sdk: require("@opentelemetry/sdk-trace"),
  contextManager: require("@opentelemetry/context-async-hooks"),
  otelCore: require("@opentelemetry/core"),
  pgStatus: require("../../../dist/integrations/pg.js").pgStatus,
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
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
