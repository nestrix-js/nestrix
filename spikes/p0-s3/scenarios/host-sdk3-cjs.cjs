// CommonJS host: its SDK 3 setup comes from the .cjs builds and its AppModule from the
// compiled CommonJS fixture (express-cjs). The Nestrix stand-in is ESM and is reached
// through require(esm), as an ESM-only @nestrix/nestjs would be.
require("reflect-metadata");
const { AppModule } = require("express-cjs/app.module");
const { setupHost } = require("./lib/host-sdk3.cjs");
const { runHostScenario } = require("./lib/host-scenario.mjs");

runHostScenario({ setupHost, appModule: AppModule, hostFormat: "cjs" }).catch(
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
