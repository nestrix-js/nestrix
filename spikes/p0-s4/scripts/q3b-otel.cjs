// Q3b: can CommonJS load the OpenTelemetry packages @nestrix/nestjs will depend on
// (architecture.md 4.5), no flags?
//   (1) require("@opentelemetry/x") from CJS: resolves each package's .cjs build.
//   (2) require() of an ES module that statically imports all of them
//       (tla/otel-graph.mjs): resolves their .mjs builds. This is the graph that
//       matters, because @nestrix/nestjs is ESM and imports them as ESM.
const path = require("node:path");

const packages = [
  "@opentelemetry/api",
  "@opentelemetry/sdk-trace",
  "@opentelemetry/resources",
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/instrumentation-undici",
  "@opentelemetry/semantic-conventions",
];

console.log(`node ${process.version}`);
let failed = 0;
const first = (err) => String(err.message).split("\n")[0];

for (const name of packages) {
  try {
    const m = require(name);
    console.log(
      `OK    (1) require("${name}") -> ${require.resolve(name).replace(/.*node_modules\/\.pnpm\//, "")} (${Object.keys(m).length} exports)`,
    );
  } catch (err) {
    failed++;
    console.log(`FAIL  (1) require("${name}"): ${err.code}: ${first(err)}`);
  }
}

let graph;
try {
  graph = require(path.join(__dirname, "../tla/otel-graph.mjs"));
  console.log(
    `OK    (2) require(tla/otel-graph.mjs) -> ${JSON.stringify(graph.sizes)}`,
  );
} catch (err) {
  failed++;
  console.log(
    `FAIL  (2) require(tla/otel-graph.mjs): ${err.code}: ${first(err)}`,
  );
}

// Use the ESM-loaded copies together, as setup code will.
if (graph) {
  try {
    const { TracerProvider, BatchSpanProcessor } = graph.sdk;
    const { resourceFromAttributes } = graph.resources;
    const { OTLPTraceExporter } = graph.exporter;
    const { UndiciInstrumentation } = graph.undici;
    const { ATTR_SERVICE_NAME } = graph.semconv;
    const provider = new TracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "spike" }),
      spanProcessors: [
        new BatchSpanProcessor({
          exporter: new OTLPTraceExporter({
            url: "http://127.0.0.1:1/v1/traces",
          }),
        }),
      ],
    });
    new UndiciInstrumentation({}).setTracerProvider(provider);
    console.log(
      "OK    (3) constructed TracerProvider + OTLP exporter + UndiciInstrumentation from the ESM graph",
    );
    provider.shutdown().catch(() => {});
  } catch (err) {
    failed++;
    console.log(`FAIL  (3) construct: ${err.code ?? ""} ${first(err)}`);
  }
}
process.exitCode = failed ? 1 : 0;
