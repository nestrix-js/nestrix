// Dual-package check for @opentelemetry/api 1.10.0 (exports: require -> dist/index.cjs,
// default -> dist/index.mjs). A CommonJS app gets the CJS build; an ESM-only library
// (like @nestrix/nestjs) gets the ESM build. Two module instances, one global registry.
//   node scripts/dual-api.cjs
"use strict";
const api = require("@opentelemetry/api");

// A tracer taken at module top level, before anything registers a provider.
const early = api.trace.getTracer("early-cjs");

// The ESM-only stand-in registers the SDK through its own (ESM) copy of the API.
const { setupTracing, finishedSpans } = require("../dist/src/nestrix/index.js");
setupTracing();

const late = api.trace.getTracer("late-cjs");
const earlySpan = early.startSpan("early");
const lateSpan = late.startSpan("late");
const result = {
  node: process.version,
  earlyRecording: earlySpan.isRecording(),
  earlySpanId: earlySpan.spanContext().spanId,
  lateRecording: lateSpan.isRecording(),
};
earlySpan.end();
lateSpan.end();
result.exported = finishedSpans().map((s) => s.name);
process.stdout.write(`__DUAL_API__${JSON.stringify(result)}\n`);
