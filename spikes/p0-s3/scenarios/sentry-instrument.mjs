// Loaded with `node --import`, before the app, as Sentry's Node/Nest setup prescribes.
// SENTRY_DSN points at a local recorder run by the test; nothing leaves the machine.
//
// S3_SENTRY_MODE:
//   default          Sentry.init({ dsn })                                    (no tracing)
//   default-traces   Sentry.init({ dsn, tracesSampleRate: 1 })
//   custom           host SDK 3 provider + ALS + W3C first, then
//                    Sentry.init({ dsn, integrations: [openTelemetryIntegration()] })
//                    (the setup the installed types document)
//   custom-traces    custom, plus tracesSampleRate: 1
//   custom-bare      custom, with defaultIntegrations: false (diagnosis only)
//   custom-nospans   custom, plus httpIntegration({ spans: false }) and
//                    nativeNodeFetchIntegration({ spans: false }) (diagnosis only)
//   otel-setup       Sentry.init({ dsn, tracesSampleRate: 1, enableOpenTelemetrySetup: true })
import * as Sentry from "@sentry/nestjs";
import { setupHost } from "./lib/host-sdk3.mjs";

const mode = process.env.S3_SENTRY_MODE ?? "default";
const dsn = process.env.SENTRY_DSN;
if (!dsn?.startsWith("http://pk@127.0.0.1:")) {
  throw new Error("refusing to run without a local SENTRY_DSN");
}

if (mode.startsWith("custom")) {
  globalThis.__host = setupHost();
}
const options = { dsn };
if (mode === "default-traces" || mode === "custom-traces") {
  options.tracesSampleRate = 1;
}
if (mode.startsWith("custom")) {
  options.integrations = [Sentry.openTelemetryIntegration()];
}
if (mode === "custom-bare") {
  options.defaultIntegrations = false;
}
if (mode === "custom-nospans") {
  options.integrations.push(
    Sentry.httpIntegration({ spans: false }),
    Sentry.nativeNodeFetchIntegration({ spans: false }),
  );
}
if (mode === "otel-setup") {
  options.tracesSampleRate = 1;
  options.enableOpenTelemetrySetup = true;
}
Sentry.init(options);
globalThis.__sentryMode = mode;
