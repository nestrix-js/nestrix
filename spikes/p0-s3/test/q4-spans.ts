// Not a test file (diagnosis): `node test/q4-spans.ts <mode> [traceparent]` prints every Sentry span
// and event compactly, next to the OpenTelemetry spans, for one GET /out + GET /boom.
import { runSentry, summarize } from "./sentry-run.ts";

const mode = process.argv[2] ?? "default";
const r = await runSentry(mode, {
  boom: true,
  traceparent: process.argv[3] || undefined,
});
const s = summarize(r);
console.log("OTEL", JSON.stringify(s.otelSpans));
for (const i of r.items) {
  if (i.type === "span") {
    const list = i.payload?.items ?? [i.payload];
    for (const sp of list) {
      console.log(
        "SENTRY span",
        JSON.stringify({
          name: sp.name ?? sp.description,
          origin: sp.attributes?.["sentry.origin"]?.value ?? sp.origin,
          t: sp.trace_id?.slice(0, 8),
          id: sp.span_id?.slice(0, 8),
          p: sp.parent_span_id?.slice(0, 8),
          route: sp.attributes?.["http.route"]?.value,
          kind: sp.kind ?? sp.attributes?.["sentry.kind"]?.value,
        }),
      );
    }
  } else if (i.type === "event") {
    console.log(
      "SENTRY event",
      JSON.stringify({
        trace: i.payload.contexts?.trace,
        transaction: i.payload.transaction,
      }),
    );
  } else console.log("SENTRY", i.type);
}
console.log("OUTBOUND", JSON.stringify(s.outbound));
console.log("PROBE", JSON.stringify(r.probe));
console.log(
  "ROUTESTATS",
  JSON.stringify(r.result.routeStats),
  "SKIPS",
  JSON.stringify(r.result.httpSkips),
);
