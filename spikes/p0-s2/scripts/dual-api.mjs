// Control for dual-api.cjs: the same sequence from an ESM app, where the app and the
// ESM-only library share one (ESM) instance of @opentelemetry/api.
//   node scripts/dual-api.mjs
import { trace } from "@opentelemetry/api";
import { finishedSpans, setupTracing } from "../dist/src/nestrix/index.js";

const early = trace.getTracer("early-esm");
setupTracing();
const late = trace.getTracer("late-esm");
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
