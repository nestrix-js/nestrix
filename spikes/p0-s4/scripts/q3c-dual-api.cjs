// Extra finding from Q3b: the OpenTelemetry packages ship a .cjs and a .mjs build, so a
// CommonJS host that require()s them and @nestrix-js/nestjs (ESM) that imports them get
// TWO module instances of @opentelemetry/api and of the SDK. Here the host is a real
// CJS host (providers from the .cjs build) and "Nestrix" only uses the ESM api copy.
// Asserts, so a wrong assumption exits non-zero.
const assert = require("node:assert");
const path = require("node:path");

// Host side: everything from the CJS builds.
const hostApi = require("@opentelemetry/api");
const hostSdk = require("@opentelemetry/sdk-trace");
const exporter = new hostSdk.InMemorySpanExporter();
const hostProvider = new hostSdk.TracerProvider({
  spanProcessors: [new hostSdk.SimpleSpanProcessor({ exporter })],
});

// Nestrix side: the ESM graph (what an ESM-only @nestrix-js/nestjs would import).
const graph = require(path.join(__dirname, "../tla/otel-graph.mjs"));
const esmApi = graph.api;

console.log(`node ${process.version}`);
assert.notStrictEqual(hostApi, esmApi);
console.log("two api instances (cjs !== esm): true");

// 1. Host registers first; Nestrix's attempt through the ESM copy reports "exists".
assert.strictEqual(hostApi.trace.setGlobalTracerProvider(hostProvider), true);
const second = esmApi.trace.setGlobalTracerProvider(
  new graph.sdk.TracerProvider({}),
);
assert.strictEqual(second, false);
console.log("host set provider: true; Nestrix (ESM api) set provider:", second);

// 2. Spans started through the ESM api copy reach the host's exporter.
const nestrixTracer = esmApi.trace.getTracer("nestrix");
nestrixTracer.startSpan("from-esm").end();
assert.deepStrictEqual(
  exporter.getFinishedSpans().map((s) => s.name),
  ["from-esm"],
);
console.log(
  "host exporter received:",
  exporter.getFinishedSpans().map((s) => s.name),
);

// 3. A span set into a Context via the CJS api copy is read via the ESM copy
//    (context keys are Symbol.for), and a child started by the ESM tracer in that
//    context gets the right parent.
const parent = hostApi.trace.getTracer("host").startSpan("host-parent");
const ctx = hostApi.trace.setSpan(hostApi.context.active(), parent);
assert.strictEqual(esmApi.trace.getSpan(ctx), parent);
const child = nestrixTracer.startSpan("nestrix-child", {}, ctx);
child.end();
parent.end();
const finished = exporter.getFinishedSpans();
const childData = finished.find((s) => s.name === "nestrix-child");
const parentId = (
  childData.parentSpanContext ?? { spanId: childData.parentSpanId }
).spanId;
assert.strictEqual(parentId, parent.spanContext().spanId);
assert.strictEqual(
  childData.spanContext().traceId,
  parent.spanContext().traceId,
);
console.log("getSpan(ctx) via ESM copy is the CJS-set span: true");
console.log(
  "child started by ESM tracer has the host span as parent, same trace: true",
);

// 4. instanceof does not work across the boundary: do not use it on API/SDK classes.
const esmExporter = new graph.sdk.InMemorySpanExporter();
const crossed = esmExporter instanceof hostSdk.InMemorySpanExporter;
assert.strictEqual(crossed, false);
console.log(
  "ESM InMemorySpanExporter instanceof CJS InMemorySpanExporter:",
  crossed,
);

hostProvider.shutdown().catch(() => {});
console.log("ALL ASSERTIONS PASSED");
