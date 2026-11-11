// ESM host: its SDK 3 setup and its AppModule come from ESM (the fixture express-esm).
import "reflect-metadata";
import { AppModule } from "express-esm/app.module";
import { runHostScenario } from "./lib/host-scenario.mjs";
import { setupHost } from "./lib/host-sdk3.mjs";

await runHostScenario({ setupHost, appModule: AppModule, hostFormat: "esm" });
