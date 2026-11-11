// Input from P0-S2: in a CommonJS app, a tracer obtained at module top level before
// Nestrix registers its provider stays a no-op. S3_CASE:
//   cross-copy   host (CJS) takes a tracer from the .cjs api copy at load time; Nestrix
//                then registers through the .mjs copy (the designed setup code)
//   via-cjs      same, but Nestrix registers its provider through the .cjs copy
//                (resolved with createRequire), a possible mitigation
// Prints RESULT with whether early/late tracers from each copy produce valid spans
// that reach Nestrix's exporter.
const cjsApi = require("@opentelemetry/api");
const early = cjsApi.trace.getTracer("host-early"); // module top level

const which = process.env.S3_CASE ?? "cross-copy";
(async () => {
  const esmApi = await import("@opentelemetry/api");
  const sdk = await import("@opentelemetry/sdk-trace"); // Nestrix's ESM SDK copy
  const exporter = new sdk.InMemorySpanExporter();
  const provider = new sdk.TracerProvider({
    spanProcessors: [new sdk.SimpleSpanProcessor({ exporter })],
  });
  const esmEarly = esmApi.trace.getTracer("nestrix-early");
  const registered =
    which === "via-cjs"
      ? cjsApi.trace.setGlobalTracerProvider(provider)
      : esmApi.trace.setGlobalTracerProvider(provider);

  const probe = (tracer, name) => {
    const span = tracer.startSpan(name);
    const valid = cjsApi.isSpanContextValid(span.spanContext());
    span.end();
    return valid;
  };
  const result = {
    case: which,
    node: process.version,
    registered,
    cjsEarly: probe(early, "cjs-early"),
    cjsLate: probe(cjsApi.trace.getTracer("host-late"), "cjs-late"),
    esmEarly: probe(esmEarly, "esm-early"),
    esmLate: probe(esmApi.trace.getTracer("nestrix-late"), "esm-late"),
  };
  result.exported = exporter.getFinishedSpans().map((s) => s.name);
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
})();
