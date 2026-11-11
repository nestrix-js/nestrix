// What an ESM-only @nestrix/nestjs will do: import the OpenTelemetry packages from an
// ES module. Those resolve through the "default" (ESM) condition, so this loads the
// packages' .mjs builds, which is a different graph from require("@opentelemetry/x")
// in a CommonJS file (that one resolves the .cjs builds).
import * as api from "@opentelemetry/api";
import * as exporter from "@opentelemetry/exporter-trace-otlp-http";
import * as undici from "@opentelemetry/instrumentation-undici";
import * as resources from "@opentelemetry/resources";
import * as sdk from "@opentelemetry/sdk-trace";
import * as semconv from "@opentelemetry/semantic-conventions";

export const sizes = {
  api: Object.keys(api).length,
  sdk: Object.keys(sdk).length,
  resources: Object.keys(resources).length,
  exporter: Object.keys(exporter).length,
  undici: Object.keys(undici).length,
  semconv: Object.keys(semconv).length,
};
export { api, exporter, resources, sdk, semconv, undici };
