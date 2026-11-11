// Review fix 9: forceFlush() and shutdown() of a processor in the host's list must
// never reject. CommonJS host (its SDK from the .cjs build); the processors come from
// the ESM stand-in. S3_CASE:
//   naive-reject   an unguarded processor whose forceFlush/shutdown reject
//   nestrix-fault  nestrixSpanProcessor({ fault: "lifecycle" }): the work throws,
//                  inside the guard
const sdk = require("@opentelemetry/sdk-trace");
const { nestrixSpanProcessor } = require("../src/nestrix/setup.mjs");

const which = process.env.S3_CASE ?? "nestrix-fault";
const extra =
  which === "naive-reject"
    ? {
        onStart() {},
        onEnd() {},
        forceFlush: () => Promise.reject(new Error("naive forceFlush")),
        shutdown: () => Promise.reject(new Error("naive shutdown")),
      }
    : nestrixSpanProcessor({ fault: "lifecycle" });
const exporter = new sdk.InMemorySpanExporter();
const provider = new sdk.TracerProvider({
  spanProcessors: [new sdk.SimpleSpanProcessor({ exporter }), extra],
});
provider.getTracer("host").startSpan("s").end();

// TracerProvider.forceFlush() rejects with an array of errors; shutdown() with one.
const reason = (e) =>
  Array.isArray(e)
    ? e.map((x) => x?.message ?? String(x)).join(", ")
    : e?.message;
const outcome = (p) =>
  p.then(
    () => "resolved",
    (e) => `rejected: ${reason(e)}`,
  );
(async () => {
  const forceFlush = await outcome(provider.forceFlush());
  const exportedBeforeShutdown = exporter.getFinishedSpans().length;
  const shutdown = await outcome(provider.shutdown());
  process.stdout.write(
    `RESULT ${JSON.stringify({
      case: which,
      node: process.version,
      forceFlush,
      shutdown,
      exported: exportedBeforeShutdown,
    })}\n`,
  );
})();
