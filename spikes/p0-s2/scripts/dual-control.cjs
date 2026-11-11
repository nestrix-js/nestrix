// Review F5 control for dual-api.cjs. A tracer taken early from the CommonJS build of
// @opentelemetry/api delegates once a provider is registered through that same CJS
// instance, and never when the provider is registered through the ESM build.
//   node scripts/dual-control.cjs same   # register through the CJS instance
//   node scripts/dual-control.cjs esm    # register through the ESM build (require(esm))
"use strict";
const path = require("node:path");

const mode = process.argv[2];
const cjsApi = require("@opentelemetry/api");
const early = cjsApi.trace.getTracer("early");
const marker = { isRecording: () => true, spanContext: () => ({}), end() {} };
const provider = { getTracer: () => ({ startSpan: () => marker }) };
const esmFile = path.join(
  path.dirname(require.resolve("@opentelemetry/api")),
  "index.mjs",
);
const registrar = mode === "same" ? cjsApi : require(esmFile);
const registered = registrar.trace.setGlobalTracerProvider(provider);
const result = {
  mode,
  registered,
  earlyDelegates: early.startSpan("x") === marker,
  lateDelegates: cjsApi.trace.getTracer("late").startSpan("y") === marker,
};
process.stdout.write(`__DUAL_CONTROL__${JSON.stringify(result)}\n`);
