// Entry point of the standalone server: configuration (P5-01), receiver (P5-01), storage
// (P5-02), query API (P5-03), UI and admin login (P5-04).
import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { createApp } from "./bootstrap.js";
import { formatConfigErrors, loadConfig } from "./config.js";

async function main(): Promise<void> {
  const result = loadConfig(process.env);
  if (!result.ok) {
    console.error(formatConfigErrors(result.errors));
    process.exitCode = 1;
    return;
  }
  const app = await createApp(result.config);
  await app.listen(result.config.port);
  new Logger("NestrixServer").log(
    `Listening on port ${result.config.port}: POST /v1/traces and /v1/logs (ingest), / (dashboard, sign in at /login)`,
  );
}

main().catch((error: unknown) => {
  console.error("nestrix-server: failed to start:", error);
  process.exitCode = 1;
});
